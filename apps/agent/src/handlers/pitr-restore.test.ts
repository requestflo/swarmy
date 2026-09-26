import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';
import type { DbRestorePayload } from '@swarmy/core/protocol';
import {
  WALG_PITR_ROLLBACK_SCRIPT,
  pickBaseBackup,
  restoreWalgPitr,
  waitVolumeIdle,
  walgPitrRestoreScript,
} from './pitr-restore';
import { stderrTail } from './backup';

/**
 * QA-087: a wal-g PITR restore stops nothing itself (the controller scales
 * the target to 0), but it never touches a live volume, keeps the original
 * PGDATA, fetches the base backup plus the archived WAL, stages recovery, and
 * rolls back cleanly on any failure. The scripts run in a real shell against
 * stub `wal-g`/`stat`/`chown` binaries.
 */

// ── the restore script, for real ─────────────────────────────────────────────

/** The wal-g image's /bin/sh is dash (Debian): test with dash when this host has it. */
const SHELL = existsSync('/bin/dash') ? '/bin/dash' : 'sh';

const WALG_STUB = `#!/bin/sh
# Stub wal-g. $STORE holds the "archive"; STUB_FAIL=fetch|walerr injects failures.
case "$1" in
  backup-fetch)
    mkdir -p "$2"
    echo 17 > "$2/PG_VERSION"
    if [ "\${STUB_FAIL:-}" = fetch ]; then echo "ERROR: fetch broke half-way" >&2; exit 1; fi
    printf 'START WAL LOCATION: 0/2000028 (file 000000010000000000000002)\\nCHECKPOINT LOCATION: 0/2000060\\n' > "$2/backup_label"
    printf "# base backup auto.conf\\n" > "$2/postgresql.auto.conf"
    echo "fetched $3" ;;
  wal-fetch)
    if [ "\${STUB_FAIL:-}" = walerr ]; then echo "ERROR: connection reset by peer" >&2; exit 1; fi
    if [ -f "$STORE/$2" ]; then cp "$STORE/$2" "$3"; exit 0; fi
    echo "ERROR: Archive '$2' does not exist." >&2; exit 74 ;;
esac`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'pitr-'));
  const bin = join(dir, 'bin');
  const store = join(dir, 'store');
  const root = join(dir, 'data');
  mkdirSync(bin);
  mkdirSync(store);
  mkdirSync(join(root, 'pgdata'), { recursive: true });
  writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '17');
  writeFileSync(join(root, 'pgdata', 'ORIGINAL'), 'live data');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  stub('wal-g', WALG_STUB);
  stub('stat', '#!/bin/sh\necho 999:999\n'); // GNU `stat -c` (macOS stat has no -c)
  stub('chown', '#!/bin/sh\nexit 0\n'); // chown to 999 needs root; the owner is asserted via stat above
  // Archive: timeline 1 segments 2..3, then a switch to timeline 2 at 0/4000000.
  for (const f of ['000000010000000000000002', '000000010000000000000003', '000000020000000000000004', '000000020000000000000005']) {
    writeFileSync(join(store, f), f);
  }
  writeFileSync(join(store, '00000002.history'), '1\t0/4000000\tno recovery target specified\n');
  const run = (script: string, extra: Record<string, string> = {}) =>
    Bun.spawnSync([SHELL, '-c', script], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        STORE: store,
        PGDATA: join(root, 'pgdata'),
        SWARMY_BACKUP_NAME: 'base_000000010000000000000002',
        SWARMY_PITR_STAMP: 's1',
        ...extra,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  return { dir, root, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('walgPitrRestoreScript (real shell)', () => {
  it('keeps the original aside, fetches the base backup + all WAL across a timeline switch, stages recovery', () => {
    const w = world();
    const r = w.run(walgPitrRestoreScript(), { SWARMY_TARGET_TIME: '2026-09-26T10:00:00Z' });
    expect(r.stderr.toString()).toBe('');
    expect(r.exitCode).toBe(0);
    // the original is KEPT, untouched
    expect(readFileSync(join(w.root, 'pgdata.pre-pitr-s1', 'ORIGINAL'), 'utf8')).toBe('live data');
    // the base backup is in place
    expect(existsSync(join(w.root, 'pgdata', 'ORIGINAL'))).toBe(false);
    expect(existsSync(join(w.root, 'pgdata', 'recovery.signal'))).toBe(true);
    // WAL: tli 1 until it ends, the history file, then tli 2 from the switch segment
    expect(readdirSync(join(w.root, 'pitr-wal')).sort()).toEqual([
      '000000010000000000000002',
      '000000010000000000000003',
      '00000002.history',
      '000000020000000000000004',
      '000000020000000000000005',
    ]);
    const conf = readFileSync(join(w.root, 'pgdata', 'postgresql.auto.conf'), 'utf8');
    expect(conf).toContain(`restore_command = 'cp ${join(w.root, 'pitr-wal')}/%f %p'`);
    expect(conf).toContain("recovery_target_time = '2026-09-26T10:00:00Z'");
    expect(conf).toContain("recovery_target_action = 'promote'");
    expect(conf).toContain("recovery_target_timeline = 'latest'");
    expect(r.stdout.toString()).toContain('fetched 4 WAL segments (last 000000020000000000000005)');
    expect(r.stdout.toString()).toContain(`kept the previous PGDATA at ${join(w.root, 'pgdata.pre-pitr-s1')}`);
    w.cleanup();
  }, 30_000);

  it('without a target time: no recovery_target_time (replay everything, then promote)', () => {
    const w = world();
    const r = w.run(walgPitrRestoreScript());
    expect(r.exitCode).toBe(0);
    const conf = readFileSync(join(w.root, 'pgdata', 'postgresql.auto.conf'), 'utf8');
    expect(conf).not.toContain('recovery_target_time =');
    w.cleanup();
  }, 30_000);

  it('a failed base-backup fetch rolls back: the original PGDATA is back, nothing of the restore remains', () => {
    const w = world();
    const r = w.run(walgPitrRestoreScript(), { STUB_FAIL: 'fetch' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('putting the original PGDATA back');
    expect(readFileSync(join(w.root, 'pgdata', 'ORIGINAL'), 'utf8')).toBe('live data');
    expect(readdirSync(w.root).sort()).toEqual(['pgdata']);
    w.cleanup();
  }, 30_000);

  it('a wal-g error that is not "does not exist" fails (and rolls back) instead of silently truncating recovery', () => {
    const w = world();
    const r = w.run(walgPitrRestoreScript(), { STUB_FAIL: 'walerr' });
    expect(r.exitCode).toBe(6);
    expect(r.stderr.toString()).toContain('connection reset by peer');
    expect(readFileSync(join(w.root, 'pgdata', 'ORIGINAL'), 'utf8')).toBe('live data');
    expect(readdirSync(w.root).sort()).toEqual(['pgdata']);
    w.cleanup();
  }, 30_000);

  it('never overwrites an existing kept copy (refuses before touching anything)', () => {
    const w = world();
    mkdirSync(join(w.root, 'pgdata.pre-pitr-s1'));
    const r = w.run(walgPitrRestoreScript());
    expect(r.exitCode).toBe(4);
    expect(readFileSync(join(w.root, 'pgdata', 'ORIGINAL'), 'utf8')).toBe('live data');
    w.cleanup();
  }, 30_000);

  it('rollback puts the kept copy back in place of a restore that did not recover', () => {
    const w = world();
    expect(w.run(walgPitrRestoreScript()).exitCode).toBe(0);
    const r = w.run(WALG_PITR_ROLLBACK_SCRIPT);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(w.root, 'pgdata', 'ORIGINAL'), 'utf8')).toBe('live data');
    expect(readdirSync(w.root).sort()).toEqual(['pgdata']);
    // nothing to roll back to: a clear failure, nothing removed
    const again = w.run(WALG_PITR_ROLLBACK_SCRIPT);
    expect(again.exitCode).toBe(4);
    expect(readFileSync(join(w.root, 'pgdata', 'ORIGINAL'), 'utf8')).toBe('live data');
    w.cleanup();
  }, 30_000);
});

// ── base-backup choice ───────────────────────────────────────────────────────

describe('pickBaseBackup', () => {
  const list = JSON.stringify([
    { backup_name: 'base_000000010000000000000002', finish_time: '2026-09-26T08:00:00Z' },
    { backup_name: 'base_000000010000000000000009', finish_time: '2026-09-26T12:00:00Z' },
  ]);
  it('the newest backup that finished before the target', () => {
    expect(pickBaseBackup(list, 'latest', '2026-09-26T10:00:00Z')).toBe('base_000000010000000000000002');
    expect(pickBaseBackup(list, undefined, '2026-09-26T13:00:00Z')).toBe('base_000000010000000000000009');
  });
  it('an explicit backup wins; no target means LATEST', () => {
    expect(pickBaseBackup(list, 'base_000000010000000000000009', '2026-09-26T10:00:00Z')).toBe('base_000000010000000000000009');
    expect(pickBaseBackup('[]', 'latest', undefined)).toBe('LATEST');
  });
  it('no backup before the target is a clear error', () => {
    expect(() => pickBaseBackup(list, 'latest', '2026-09-26T07:00:00Z')).toThrow(/no base backup finished before/);
    expect(() => pickBaseBackup('not json', 'latest', '2026-09-26T07:00:00Z')).toThrow(/backup list/);
  });
});

// ── orchestration against a fake Docker ──────────────────────────────────────

function fakeDocker(opts: { volumeUsers?: number; list?: string; restoreFails?: string } = {}) {
  const created: Array<{ Cmd: string[]; Env: string[]; HostConfig: { Binds: string[]; NetworkMode?: string } }> = [];
  let volumeUsers = opts.volumeUsers ?? 0;
  const docker = {
    pullImage: async () => undefined,
    docker: {
      getImage: () => ({ inspect: async () => ({ Config: {} }) }),
      getService: () => ({ inspect: async () => Promise.reject(new Error('not a manager')) }),
      getNetwork: () => ({ connect: async () => undefined }),
      listContainers: async (o: { filters: { volume?: string[] } }) => {
        if (!o.filters.volume) return [];
        if (volumeUsers > 0) {
          volumeUsers -= 1;
          return [{ Names: ['/qa-data_pitrcopy-primary.1.abc'] }];
        }
        return [];
      },
      modem: {
        demuxStream: (_s: unknown, out: { write(b: Buffer): void }, err: { write(b: Buffer): void }) => {
          const cmd = created[created.length - 1]!.Cmd.join(' ');
          if (cmd.includes('backup-list')) out.write(Buffer.from(opts.list ?? '[]'));
          else if (opts.restoreFails) err.write(Buffer.from(opts.restoreFails));
          else out.write(Buffer.from('swarmy: kept the previous PGDATA at /var/lib/postgresql/data/pgdata.pre-pitr-s1\n'));
        },
      },
      createContainer: async (o: { Cmd: string[]; Env: string[]; HostConfig: { Binds: string[] } }) => {
        created.push(o);
        const failing = Boolean(opts.restoreFails) && !o.Cmd.join(' ').includes('backup-list');
        return {
          id: `c${created.length}`,
          attach: async () => ({}),
          start: async () => undefined,
          wait: async () => ({ StatusCode: failing ? 1 : 0 }),
          kill: async () => undefined,
          remove: async () => undefined,
        };
      },
    },
  } as unknown as DockerClient;
  return { docker, created };
}

const payload = (over: Partial<DbRestorePayload> = {}): DbRestorePayload => ({
  commandId: 'c1',
  engine: 'wal-g',
  mode: 'pitr',
  conn: { host: 'qa-data_pitrcopy-primary', port: 5432, user: 'postgres', password: '', database: 'app' },
  repo: { kind: 's3', repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' },
  snapshotId: 'latest',
  targetTime: '2026-09-26T10:00:00Z',
  tags: [],
  dataVolume: 'qa-data_pitrcopy-primary-data',
  network: 'qa-data_pitrcopy-net',
  resticNetwork: 'swarmy',
  pitrStamp: 's1',
  ...over,
});
const noSleep = async () => undefined;

describe('restoreWalgPitr', () => {
  const list = JSON.stringify([{ backup_name: 'base_000000010000000000000002', finish_time: '2026-09-26T08:00:00Z' }]);

  it('waits for the stopped target, picks the backup before the target, restores with the server layout', async () => {
    const { docker, created } = fakeDocker({ volumeUsers: 2, list });
    const res = await restoreWalgPitr(docker, payload(), Date.now(), () => undefined, { sleep: noSleep });
    expect(res).toMatchObject({
      backupName: 'base_000000010000000000000002',
      recoveredTo: '2026-09-26T10:00:00Z',
      asidePath: '/var/lib/postgresql/data/pgdata.pre-pitr-s1',
    });
    expect(created).toHaveLength(2);
    expect(created[0]!.Cmd.join(' ')).toContain('wal-g backup-list --json --detail');
    const restore = created[1]!;
    expect(restore.HostConfig.Binds).toEqual(['qa-data_pitrcopy-primary-data:/var/lib/postgresql/data']);
    expect(restore.Env).toContain('PGDATA=/var/lib/postgresql/data/pgdata');
    expect(restore.Env).toContain('SWARMY_BACKUP_NAME=base_000000010000000000000002');
    expect(restore.Env).toContain('SWARMY_PITR_STAMP=s1');
    expect(restore.Env).toContain('SWARMY_TARGET_TIME=2026-09-26T10:00:00Z');
    // no DB password is needed (or sent) for a physical restore
    expect(restore.Env.some((e) => e.startsWith('PGPASSWORD'))).toBe(false);
  });

  it('refuses to touch a volume a server still runs on', async () => {
    const { docker, created } = fakeDocker({ volumeUsers: 99 });
    await expect(
      restoreWalgPitr(docker, payload(), Date.now(), () => undefined, { sleep: noSleep, idleTimeoutMs: 0 }),
    ).rejects.toThrow(/still in use by qa-data_pitrcopy-primary\.1\.abc/);
    expect(created).toHaveLength(0);
  });

  it('a failed restore reports the TAIL of stderr (the real error), not the INFO head', async () => {
    const noise = Array.from({ length: 40 }, (_, i) => `INFO: 2026/09/26 10:00:${String(i).padStart(2, '0')} fetching part ${i}`).join('\n');
    const { docker } = fakeDocker({ restoreFails: `${noise}\nERROR: found file PG_VERSION in directory /var/lib/postgresql/data/pgdata\n` });
    const err = await restoreWalgPitr(docker, payload({ snapshotId: 'base_000000010000000000000002' }), Date.now(), () => undefined, {
      sleep: noSleep,
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('ERROR: found file PG_VERSION');
    expect((err as Error).message.length).toBeLessThanOrEqual(601);
  });

  it('rollback runs the rollback script only, with no S3 network or credentials', async () => {
    const { docker, created } = fakeDocker();
    await restoreWalgPitr(docker, payload({ pitrAction: 'rollback' }), Date.now(), () => undefined, { sleep: noSleep });
    expect(created).toHaveLength(1);
    expect(created[0]!.Cmd).toEqual([WALG_PITR_ROLLBACK_SCRIPT]);
    expect(created[0]!.Env).toEqual(['PGDATA=/var/lib/postgresql/data/pgdata', 'SWARMY_PITR_STAMP=s1']);
    expect(created[0]!.HostConfig.NetworkMode).toBeUndefined();
  });

  it('needs a stamp (so the kept copy can be found again)', async () => {
    const { docker } = fakeDocker();
    await expect(restoreWalgPitr(docker, payload({ pitrStamp: undefined }), Date.now(), () => undefined)).rejects.toThrow(/pitrStamp/);
  });
});

describe('waitVolumeIdle', () => {
  it('returns once no running container mounts the volume', async () => {
    const { docker } = fakeDocker({ volumeUsers: 3 });
    let slept = 0;
    await waitVolumeIdle(docker, 'v', 60_000, async () => {
      slept += 1;
    });
    expect(slept).toBe(3);
  });
});

describe('stderrTail (QA-087 d)', () => {
  it('keeps the last lines, marked when cut; falls back when empty', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const t = stderrTail(`${long}\nERROR: the real reason\n`, 'x');
    expect(t.startsWith('…')).toBe(true);
    expect(t.endsWith('ERROR: the real reason')).toBe(true);
    expect(stderrTail('  \n', 'wal-g exited 1')).toBe('wal-g exited 1');
    expect(stderrTail('one line', 'x')).toBe('one line');
  });
});
