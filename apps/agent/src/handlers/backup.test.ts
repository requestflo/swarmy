import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { DbBackupPayload, DbRestorePayload } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import {
  assertContainerPath,
  backupDb,
  MANAGED_PG_LAYOUT,
  pgDataLayoutFrom,
  resolvePgDataLayout,
  restoreDb,
  assertSnapshotRef,
  assertVolumeName,
  forgetArgsFor,
  logicalRestoreScript,
  parseForgetRemoved,
  pgBackRestRepoFlags,
  pgConnEnv,
  pgEnv,
  pgPassfileLine,
  pgbackrestRestoreScript,
  pitrScriptEnv,
  repoBinds,
  shq,
  walgRestoreScript,
  physicalNetworks,
  physicalSidecarTimeoutMs,
  pgbackrestBackupScript,
  runSidecar,
  S3_PREFLIGHT,
  WALG_BACKUP_SCRIPT,
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
    const archives: Array<{ tar: Buffer; path: string }> = [];
    const docker = {
      pullImage: async () => undefined,
      docker: {
        getImage: () => ({ inspect: async () => ({ Config: { User: '' } }) }),
        listContainers: async () => [],
        getService: () => ({ inspect: async () => Promise.reject(new Error('not a manager')) }),
        modem: { demuxStream: (_s: unknown, o: { write(b: Buffer): void }) => o.write(Buffer.from(out)) },
        createContainer: async (opts: { Image: string; Env: string[]; Cmd: string[] }) => {
          created.push(opts);
          return {
            putArchive: async (tar: Buffer, o: { path: string }) => void archives.push({ tar, path: o.path }),
            attach: async () => ({}),
            start: async () => undefined,
            wait: async () => ({ StatusCode: 0 }),
            remove: async () => undefined,
          };
        },
      },
    } as unknown as DockerClient;
    return { docker, created, archives };
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

  it('pgConnEnv carries the libpq target + a PGPASSFILE path — never the password', () => {
    expect(pgConnEnv(payload('wal-g').conn)).toEqual([
      'PGHOST=shop_main-primary',
      'PGPORT=5432',
      'PGUSER=postgres',
      'PGPASSFILE=/tmp/.swarmy-pgpass',
      'PGDATABASE=app',
    ]);
    expect(pgEnv(payload('wal-g').conn).join(' ')).not.toContain('s3cr3t');
  });

  it('pgPassfileLine escapes libpq separators', () => {
    expect(pgPassfileLine('a:b\\c')).toBe('*:*:*:*:a\\:b\\\\c\n');
  });

  it('wal-g backup-push gets PGHOST/PGUSER + a 0600 PGPASSFILE; the password is in no env or argv', async () => {
    const { docker, created, archives } = fakeDocker('Wrote backup with name base_000000010000000000000003\n');
    const res = await backupDb(docker, conn, payload('wal-g'));
    expect(res.snapshotId).toBe('base_000000010000000000000003');
    expect(created).toHaveLength(1);
    const env = created[0]!.Env;
    expect(env).toContain('PGHOST=shop_main-primary');
    expect(env).toContain('PGPORT=5432');
    expect(env).toContain('PGUSER=postgres');
    expect(env).toContain('PGPASSFILE=/tmp/.swarmy-pgpass');
    expect(env.join(' ')).not.toContain('s3cr3t');
    expect(env).toContain('WALG_S3_PREFIX=s3://bkt/pfx');
    expect(created[0]!.Cmd.join(' ')).not.toContain('s3cr3t');
    // The passfile is put into the container before it starts: 0600, the password inside.
    expect(archives).toHaveLength(1);
    expect(archives[0]!.path).toBe('/tmp');
    const tar = archives[0]!.tar;
    expect(tar.subarray(0, 14).toString('ascii')).toBe('.swarmy-pgpass');
    expect(tar.subarray(100, 107).toString('ascii')).toBe('0000600');
    expect(tar.subarray(512, 512 + 15).toString('utf8')).toBe('*:*:*:*:s3cr3t\n');
  });

  it('pgbackrest backup gets the same connection env', async () => {
    const { docker, created } = fakeDocker('');
    await backupDb(docker, conn, payload('pgbackrest'));
    const env = created[0]!.Env;
    expect(env).toContain('PGHOST=shop_main-primary');
    expect(env).toContain('PGUSER=postgres');
    expect(env.join(' ')).not.toContain('s3cr3t');
    expect(created[0]!.Cmd.join(' ')).not.toContain('s3cr3t');
  });
});

/**
 * QA-074: the physical sidecars must see the data at the SAME paths as the
 * Postgres server. wal-g refuses a PGDATA that differs from the server's
 * `data_directory`, and a restore must land where the server reads.
 */
describe('physical sidecars use the server data layout (QA-074)', () => {
  const VOL = 'shop_main-primary-data';
  /** A member container as `docker inspect` reports it (a custom layout, to prove nothing is hardcoded). */
  const serverContainer = {
    Mounts: [
      { Type: 'volume', Name: 'shop_main-wal-archive', Destination: '/wal-archive' },
      { Type: 'volume', Name: VOL, Source: `/var/lib/docker/volumes/${VOL}/_data`, Destination: '/srv/pg' },
    ],
    Config: { Env: ['POSTGRES_PASSWORD=pw', 'PGDATA=/srv/pg/cluster'] },
  };

  function fakeDocker(opts: { container?: unknown; service?: unknown } = {}) {
    const created: Array<{ Env: string[]; Cmd: string[]; HostConfig: { Binds: string[] } }> = [];
    const archives: Array<{ tar: Buffer; path: string }> = [];
    const filters: unknown[] = [];
    const docker = {
      pullImage: async () => undefined,
      docker: {
        getImage: () => ({ inspect: async () => ({ Config: {} }) }),
        listContainers: async (o: { filters: unknown }) => {
          filters.push(o.filters);
          return opts.container ? [{ Id: 'c-old', Created: 1 }, { Id: 'c-new', Created: 2 }] : [];
        },
        getContainer: (id: string) => ({
          inspect: async () => (id === 'c-new' ? opts.container : { Mounts: [], Config: { Env: [] } }),
        }),
        getService: () => ({
          inspect: async () => (opts.service ? opts.service : Promise.reject(new Error('This node is not a swarm manager'))),
        }),
        modem: { demuxStream: () => undefined },
        createContainer: async (o: { Env: string[]; Cmd: string[]; HostConfig: { Binds: string[] } }) => {
          created.push(o);
          return {
            putArchive: async (tar: Buffer, o: { path: string }) => void archives.push({ tar, path: o.path }),
            attach: async () => ({}),
            start: async () => undefined,
            wait: async () => ({ StatusCode: 0 }),
            remove: async () => undefined,
          };
        },
      },
    } as unknown as DockerClient;
    return { docker, created, filters };
  }
  const conn = { send: () => undefined } as unknown as AgentConnection;
  const pgConn = { host: 'shop_main-primary', port: 5432, user: 'postgres', password: 'pw', database: 'app' };
  const repo = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' };
  const backup = (engine: 'wal-g' | 'pgbackrest'): DbBackupPayload => ({
    commandId: 'c1', jobId: 'j1', engine, conn: pgConn, repo, tags: [], dataVolume: VOL,
  });
  const restore = (engine: 'wal-g' | 'pgbackrest'): DbRestorePayload => ({
    commandId: 'c2', engine, mode: 'pitr', conn: pgConn, repo, snapshotId: 'latest', tags: [], dataVolume: VOL,
    targetTime: '2026-09-24T15:30:00Z',
  });
  const expectServerLayout = (c: { Env: string[]; Cmd: string[]; HostConfig: { Binds: string[] } }, mode: string) => {
    expect(c.HostConfig.Binds).toEqual([`${VOL}:/srv/pg${mode}`]);
    expect(c.Env).toContain('PGDATA=/srv/pg/cluster');
    // Scripts read $PGDATA; no sidecar-only path anywhere.
    expect(c.Cmd.join(' ')).not.toContain('/pgvol');
    expect(c.Cmd.join(' ')).toContain('"$PGDATA"');
  };

  it('reads mount target + PGDATA from the live server container (newest task, by service name)', async () => {
    const { docker, filters } = fakeDocker({ container: serverContainer });
    expect(await resolvePgDataLayout(docker, 'shop_main-primary', VOL)).toEqual({
      mountTarget: '/srv/pg',
      pgdata: '/srv/pg/cluster',
    });
    expect(filters[0]).toEqual({ label: ['com.docker.swarm.service.name=shop_main-primary'] });
  });

  it('falls back to the service spec (manager), then to the managed layout', async () => {
    const service = {
      Spec: { TaskTemplate: { ContainerSpec: { Mounts: [{ Source: VOL, Target: '/data' }], Env: ['PGDATA=/data/pg'] } } },
    };
    expect(await resolvePgDataLayout(fakeDocker({ service }).docker, 'svc', VOL)).toEqual({
      mountTarget: '/data',
      pgdata: '/data/pg',
    });
    expect(await resolvePgDataLayout(fakeDocker().docker, 'svc', VOL)).toEqual(MANAGED_PG_LAYOUT);
    expect(MANAGED_PG_LAYOUT).toEqual({ mountTarget: '/var/lib/postgresql/data', pgdata: '/var/lib/postgresql/data/pgdata' });
  });

  it('pgDataLayoutFrom refuses a PGDATA off the data volume and unsafe paths', () => {
    expect(pgDataLayoutFrom({ mounts: [{ source: 'other', target: '/x' }], env: [] }, VOL)).toBeNull();
    expect(() => pgDataLayoutFrom({ mounts: [{ source: VOL, target: '/srv/pg' }], env: ['PGDATA=/elsewhere'] }, VOL)).toThrow(
      /not on the data volume/,
    );
    expect(() => pgDataLayoutFrom({ mounts: [{ source: VOL, target: '/srv/pg' }], env: ['PGDATA=/srv/pg/../x'] }, VOL)).toThrow(
      /unsafe/,
    );
    // No PGDATA env: the official image default.
    expect(pgDataLayoutFrom({ mounts: [{ source: VOL, target: '/var/lib/postgresql/data' }], env: [] }, VOL)).toEqual({
      mountTarget: '/var/lib/postgresql/data',
      pgdata: '/var/lib/postgresql/data',
    });
  });

  it('wal-g base backup mounts the volume where the server does and uses its PGDATA', async () => {
    const { docker, created } = fakeDocker({ container: serverContainer });
    await backupDb(docker, conn, backup('wal-g'));
    expectServerLayout(created[0]!, ':ro');
  });

  it('pgbackrest base backup uses the server layout too', async () => {
    const { docker, created } = fakeDocker({ container: serverContainer });
    await backupDb(docker, conn, backup('pgbackrest'));
    expectServerLayout(created[0]!, '');
  });

  it('wal-g restore fetch lands at the server layout (with the recovery target under $PGDATA)', async () => {
    const { docker, created } = fakeDocker({ container: serverContainer });
    await restoreDb(docker, conn, restore('wal-g'));
    expectServerLayout(created[0]!, '');
    expect(created[0]!.Cmd.join(' ')).toContain('"$PGDATA/recovery.signal"');
  });

  it('pgbackrest restore lands at the server layout', async () => {
    const { docker, created } = fakeDocker({ container: serverContainer });
    await restoreDb(docker, conn, restore('pgbackrest'));
    expectServerLayout(created[0]!, '');
  });

  it('with no live truth, the default managed member layout is used (not a sidecar-only path)', async () => {
    const { docker, created } = fakeDocker();
    await backupDb(docker, conn, backup('wal-g'));
    expect(created[0]!.HostConfig.Binds).toEqual([`${VOL}:/var/lib/postgresql/data:ro`]);
    expect(created[0]!.Env).toContain('PGDATA=/var/lib/postgresql/data/pgdata');
  });
});

/**
 * QA-079: the physical sidecar must reach BOTH the DB (cluster net) and an
 * in-cluster S3 destination (the storage overlay), and a stuck run must fail
 * with a clear error instead of hanging the job.
 */
describe('physical sidecar networks + hard timeout (QA-079)', () => {
  it('physicalNetworks: cluster net as the mode, storage overlay joined as well', () => {
    expect(physicalNetworks({ network: 'qa-data_pg-net', resticNetwork: 'swarmy' })).toEqual({
      networkMode: 'qa-data_pg-net',
      networks: ['swarmy'],
    });
    expect(physicalNetworks({ network: 'qa-data_pg-net' })).toEqual({ networkMode: 'qa-data_pg-net' });
    expect(physicalNetworks({ resticNetwork: 'swarmy' })).toEqual({ networkMode: 'swarmy' });
    expect(physicalNetworks({ network: 'swarmy', resticNetwork: 'swarmy' })).toEqual({ networkMode: 'swarmy' });
    expect(physicalNetworks({})).toEqual({});
  });

  function fakeDocker(opts: { hang?: boolean } = {}) {
    const created: Array<{ Env: string[]; Cmd: string[]; HostConfig: { NetworkMode?: string } }> = [];
    const connected: Array<{ net: string; container: string }> = [];
    let killed = false;
    let removed = false;
    const docker = {
      pullImage: async () => undefined,
      docker: {
        listContainers: async () => [],
        getService: () => ({ inspect: async () => Promise.reject(new Error('not a manager')) }),
        getImage: () => ({ inspect: async () => ({ Config: { User: '' } }) }),
        getNetwork: (net: string) => ({
          connect: async (o: { Container: string }) => {
            connected.push({ net, container: o.Container });
          },
        }),
        modem: { demuxStream: () => undefined },
        createContainer: async (o: { Env: string[]; Cmd: string[]; HostConfig: { NetworkMode?: string } }) => {
          created.push(o);
          return {
            id: 'sidecar-1',
            putArchive: async () => undefined,
            attach: async () => ({}),
            start: async () => undefined,
            wait: () => (opts.hang ? new Promise(() => undefined) : Promise.resolve({ StatusCode: 0 })),
            kill: async () => {
              killed = true;
            },
            remove: async () => {
              removed = true;
            },
          };
        },
      },
    } as unknown as DockerClient;
    return { docker, created, connected, state: () => ({ killed, removed }) };
  }
  const conn = { send: () => undefined } as unknown as AgentConnection;
  const pgConn = { host: 'qa-data_pg-primary', port: 5432, user: 'postgres', password: 'pw', database: 'app' };
  const repo = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' };

  it('wal-g base backup joins the cluster net AND the storage overlay', async () => {
    const { docker, created, connected } = fakeDocker();
    const p: DbBackupPayload = {
      commandId: 'c1', jobId: 'j1', engine: 'wal-g', conn: pgConn, repo, tags: [],
      dataVolume: 'qa-data_pg-primary-data', network: 'qa-data_pg-net', resticNetwork: 'swarmy',
    };
    await backupDb(docker, conn, p);
    expect(created[0]!.HostConfig.NetworkMode).toBe('qa-data_pg-net');
    expect(connected).toEqual([{ net: 'swarmy', container: 'sidecar-1' }]);
    expect(created[0]!.Env).toContain('SWARMY_S3_HOST=swarmy-garage');
  });

  it('the PITR restore fetch joins both networks too', async () => {
    const { docker, connected } = fakeDocker();
    const p: DbRestorePayload = {
      commandId: 'c2', engine: 'wal-g', mode: 'pitr', conn: pgConn, repo, snapshotId: 'latest', tags: [],
      dataVolume: 'qa-data_pg-primary-data', network: 'qa-data_pg-net', resticNetwork: 'swarmy',
    };
    await restoreDb(docker, conn, p);
    expect(connected).toEqual([{ net: 'swarmy', container: 'sidecar-1' }]);
  });

  it('a hung sidecar is killed, removed, and fails with a clear error', async () => {
    const { docker, state } = fakeDocker({ hang: true });
    await expect(
      runSidecar(docker, {
        image: 'walg', args: [], env: [], binds: [],
        timeout: { ms: 20, what: 'wal-g backup-push' },
      }),
    ).rejects.toThrow(/wal-g backup-push did not finish within 0s and was stopped/);
    expect(state()).toEqual({ killed: true, removed: true });
  });

  it('the ceiling is the command budget less a margin (so the agent reports first)', () => {
    expect(physicalSidecarTimeoutMs(undefined, 'dbBackup')).toBe(4 * 3_600_000 - 60_000);
    expect(physicalSidecarTimeoutMs(600_000, 'dbRestore')).toBe(540_000);
    expect(physicalSidecarTimeoutMs(1_000, 'dbBackup')).toBe(30_000);
  });

  it('every physical script runs the S3 preflight first', () => {
    for (const script of [WALG_BACKUP_SCRIPT, pgbackrestBackupScript('--f'), walgRestoreScript(true), pgbackrestRestoreScript('--f', false)]) {
      expect(script.startsWith(`set -e; ${S3_PREFLIGHT}`)).toBe(true);
    }
  });

  it('the preflight fails fast on an unresolvable destination host (real shell, stub getent)', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/swarmy-getent-${process.pid}`;
    await Bun.write(`${dir}/getent`, '#!/bin/sh\n[ "$2" = "swarmy-garage" ] && exit 2; echo "10.0.0.1 $2"\n');
    Bun.spawnSync(['chmod', '+x', `${dir}/getent`]);
    const run = (host: string) =>
      Bun.spawnSync(['sh', '-c', `${S3_PREFLIGHT}echo ok`], {
        env: { PATH: `${dir}:/usr/bin:/bin`, SWARMY_S3_HOST: host },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    const bad = run('swarmy-garage');
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr.toString()).toContain('does not resolve from the backup sidecar');
    const good = run('s3.example.com');
    expect(good.exitCode).toBe(0);
    expect(good.stdout.toString().trim()).toBe('ok');
    Bun.spawnSync(['rm', '-rf', dir]);
  });
});
