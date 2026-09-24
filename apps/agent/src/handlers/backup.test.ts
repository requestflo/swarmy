import { describe, expect, it } from 'bun:test';
import {
  assertContainerPath,
  assertSnapshotRef,
  assertVolumeName,
  forgetArgsFor,
  logicalRestoreScript,
  parseForgetRemoved,
  pgBackRestRepoFlags,
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
