import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { DbBackupPayload } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import {
  assertContainerPath,
  backupDb,
  assertSnapshotRef,
  assertVolumeName,
  forgetArgsFor,
  logicalRestoreScript,
  parseForgetRemoved,
  pgBackRestRepoFlags,
  pgConnEnv,
  pgEnv,
  pgbackrestRestoreScript,
  pitrScriptEnv,
  repoBinds,
  shq,
  walgRestoreScript,
} from './backup';

describe('forgetArgsFor (retention → restic forget invocation)', () => {
  it('builds --keep-within <N>d --prune scoped to the backup tags + host', () => {
    expect(
      forgetArgsFor({
        retentionDays: 30,
        tags: ['org:o1', 'volume:shop_db-data'],
        host: 'shop_db-data',
      }),
    ).toEqual([
      'forget',
      '--keep-within',
      '30d',
      '--prune',
      '--json',
      '--tag',
      'org:o1,volume:shop_db-data',
      '--host',
      'shop_db-data',
    ]);
  });

  it('joins ALL tags into ONE --tag value (AND) — repeated --tag flags would OR-match and forget other volumes', () => {
    const args = forgetArgsFor({ retentionDays: 7, tags: ['org:o1', 'db:shop/main', 'engine:pg_dump'] });
    const tagFlags = args!.filter((a) => a === '--tag');
    expect(tagFlags).toHaveLength(1);
    expect(args![args!.indexOf('--tag') + 1]).toBe('org:o1,db:shop/main,engine:pg_dump');
  });

  it('never prunes without an explicit retentionDays', () => {
    expect(forgetArgsFor({ tags: ['org:o1', 'volume:v'], host: 'v' })).toBeNull();
    expect(forgetArgsFor({ retentionDays: undefined, tags: [] })).toBeNull();
  });

  it('omits --tag/--host when the backup carried none (still bounded by --keep-within)', () => {
    expect(forgetArgsFor({ retentionDays: 14, tags: [] })).toEqual([
      'forget',
      '--keep-within',
      '14d',
      '--prune',
      '--json',
    ]);
  });
});

describe('parseForgetRemoved (restic forget --json output)', () => {
  it('sums removed snapshots across groups, ignoring prune progress noise', () => {
    const out = [
      JSON.stringify([
        { tags: null, host: 'v1', paths: ['/data'], keep: [{ id: 'a' }], remove: [{ id: 'b' }, { id: 'c' }] },
        { tags: null, host: 'v2', paths: ['/data'], keep: [{ id: 'd' }], remove: null },
      ]),
      'repository contains 5 packs',
      'removed 2 old cache directories',
    ].join('\n');
    expect(parseForgetRemoved(out)).toBe(2);
  });

  it('returns 0 when nothing aged out', () => {
    expect(parseForgetRemoved(JSON.stringify([{ keep: [{ id: 'a' }], remove: [] }]))).toBe(0);
  });

  it('returns 0 on empty or non-JSON output', () => {
    expect(parseForgetRemoved('')).toBe(0);
    expect(parseForgetRemoved('unable to open repo')).toBe(0);
  });
});

describe('repoBinds', () => {
  it('binds a node-path repo from the host so snapshots outlive the sidecar', () => {
    expect(repoBinds({ kind: 'node', repo: '/srv/backups/x', password: 'p' })).toEqual([
      '/srv/backups/x:/srv/backups/x',
    ]);
  });

  it('binds nothing for s3 repos', () => {
    expect(repoBinds({ kind: 's3', repo: 's3:https://h/b', password: 'p' })).toEqual([]);
  });
});

// ── C1/C2: payload values never become host binds or shell ───────────────────

describe('assertVolumeName (a volume "name" starting with / is a HOST bind)', () => {
  it('accepts Docker named volumes', () => {
    for (const v of ['swarmy-registry-data', 'shop_db-data', 'v', 'a.b_c-1']) expect(assertVolumeName(v)).toBe(v);
  });
  it('rejects host paths, traversal and bind options', () => {
    for (const v of ['/', '/etc', '../x', './x', 'a:b', 'a:/data:rw', '', '-v', 'a b', 'a/b']) {
      expect(() => assertVolumeName(v)).toThrow(/unsafe volume name/);
    }
  });
  it('container paths: absolute, no options, no ..', () => {
    expect(assertContainerPath('/data')).toBe('/data');
    for (const v of ['data', '/data:rw', '/../etc', '/a/../../b', '/a b']) expect(() => assertContainerPath(v)).toThrow();
  });
  it('snapshot refs never start with - and carry no shell', () => {
    for (const v of ['latest', 'a1b2c3d4', 'base_000000010000000000000003', 'pgbackrest:latest']) {
      expect(assertSnapshotRef(v)).toBe(v);
    }
    for (const v of ['--help', '$(id)', 'x;rm -rf /', 'a b', '']) expect(() => assertSnapshotRef(v)).toThrow();
  });
});

describe('Postgres restore scripts carry NO payload value (env only)', () => {
  const evil = `x"; touch /pwned; echo "`;

  it('logical restore references $DBNAME; the name rides pgEnv', () => {
    const script = logicalRestoreScript(false);
    expect(script).toContain('-d "$DBNAME"');
    expect(script).not.toContain(evil);
    expect(pgEnv({ host: 'h', port: 5432, user: 'u', password: 'p', database: 'app' })).toContain('DBNAME=app');
  });

  it('wal-g script reads $SWARMY_BACKUP_NAME / $SWARMY_TARGET_TIME', () => {
    const s = walgRestoreScript(true);
    expect(s).toContain('"$SWARMY_BACKUP_NAME"');
    expect(s).toContain('"$SWARMY_TARGET_TIME"');
    expect(s).not.toContain('2026-09-24');
    expect(walgRestoreScript(false)).not.toContain('recovery_target_time');
  });

  it('pgbackrest script reads $SWARMY_TARGET_TIME', () => {
    expect(pgbackrestRestoreScript('--f', true)).toContain('--target="$SWARMY_TARGET_TIME"');
    expect(pgbackrestRestoreScript('--f', false)).toContain('--type=default');
  });

  it('pitrScriptEnv validates and carries the values as env', () => {
    expect(pitrScriptEnv({ snapshotId: 'latest', targetTime: '2026-09-24T15:30:00Z' })).toEqual([
      'SWARMY_BACKUP_NAME=LATEST',
      'SWARMY_TARGET_TIME=2026-09-24T15:30:00Z',
    ]);
    expect(pitrScriptEnv({ snapshotId: 'base_0001' })).toEqual(['SWARMY_BACKUP_NAME=base_0001']);
    expect(() => pitrScriptEnv({ targetTime: evil })).toThrow(/recovery target time/);
    expect(() => pitrScriptEnv({ targetTime: "2026-01-01'; DROP" })).toThrow();
    expect(() => pitrScriptEnv({ snapshotId: '$(reboot)' })).toThrow(/snapshot id/);
  });

  it('pgbackrest repo flags are shell-quoted', () => {
    const f = pgBackRestRepoFlags(
      { kind: 's3', repo: 's3:https://h/b/p', password: 'x', region: "eu'; id #" },
      'b$(id)',
      'https://h',
      'p',
    );
    expect(f).toContain(`--repo1-s3-bucket='b$(id)'`);
    expect(f).toContain(`--repo1-s3-region=${shq("eu'; id #")}`);
  });

  it('shq round-trips through a real shell', async () => {
    const v = `a'b"c$(id)\`x\``;
    const proc = Bun.spawn(['sh', '-c', `printf %s ${shq(v)}`], { stdout: 'pipe' });
    expect(await new Response(proc.stdout).text()).toBe(v);
  });
});

/**
 * QA-067: a physical base backup opens a libpq session to the primary
 * (`pg_backup_start`), so its sidecar needs the PG* connection env. A fake
 * Docker captures exactly what the sidecar container was created with.
 */
describe('physical base-backup sidecar connection env (QA-067)', () => {
  function fakeDocker(out: string) {
    const created: Array<{ Image: string; Env: string[]; Cmd: string[] }> = [];
    const docker = {
      pullImage: async () => undefined,
      docker: {
        modem: { demuxStream: (_s: unknown, o: { write(b: Buffer): void }) => o.write(Buffer.from(out)) },
        createContainer: async (opts: { Image: string; Env: string[]; Cmd: string[] }) => {
          created.push(opts);
          return {
            attach: async () => ({}),
            start: async () => undefined,
            wait: async () => ({ StatusCode: 0 }),
            remove: async () => undefined,
          };
        },
      },
    } as unknown as DockerClient;
    return { docker, created };
  }
  const conn = { send: () => undefined } as unknown as AgentConnection;
  const payload = (engine: 'wal-g' | 'pgbackrest'): DbBackupPayload => ({
    commandId: 'c1',
    jobId: 'j1',
    engine,
    conn: { host: 'shop_main-primary', port: 5432, user: 'postgres', password: 's3cr3t', database: 'app' },
    repo: { kind: 's3', repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp', accessKeyId: 'AK', secretAccessKey: 'SK' },
    tags: [],
    network: 'shop_main-net',
    dataVolume: 'shop_main-primary-data',
  });

  it('pgConnEnv carries the libpq target + password as env', () => {
    expect(pgConnEnv(payload('wal-g').conn)).toEqual([
      'PGHOST=shop_main-primary',
      'PGPORT=5432',
      'PGUSER=postgres',
      'PGPASSWORD=s3cr3t',
      'PGDATABASE=app',
    ]);
  });

  it('wal-g backup-push gets PGHOST/PGUSER/PGPASSWORD in its container env (never argv)', async () => {
    const { docker, created } = fakeDocker('Wrote backup with name base_000000010000000000000003\n');
    const res = await backupDb(docker, conn, payload('wal-g'));
    expect(res.snapshotId).toBe('base_000000010000000000000003');
    expect(created).toHaveLength(1);
    const env = created[0]!.Env;
    expect(env).toContain('PGHOST=shop_main-primary');
    expect(env).toContain('PGPORT=5432');
    expect(env).toContain('PGUSER=postgres');
    expect(env).toContain('PGPASSWORD=s3cr3t');
    expect(env).toContain('WALG_S3_PREFIX=s3://bkt/pfx');
    expect(created[0]!.Cmd.join(' ')).not.toContain('s3cr3t');
  });

  it('pgbackrest backup gets the same connection env', async () => {
    const { docker, created } = fakeDocker('');
    await backupDb(docker, conn, payload('pgbackrest'));
    const env = created[0]!.Env;
    expect(env).toContain('PGHOST=shop_main-primary');
    expect(env).toContain('PGUSER=postgres');
    expect(env).toContain('PGPASSWORD=s3cr3t');
    expect(created[0]!.Cmd.join(' ')).not.toContain('s3cr3t');
  });
});
