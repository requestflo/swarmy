import { seedKvRows } from './swarm-kv.service';
import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  checkRestorePreconditions,
  copyVolumeName,
  coverageFor,
  detectAppDbs,
  restoreAppDb,
  runAppDbBackup,
  runScheduledAppDbDump,
} from './appDbBackup.service';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-appdb-backups';

function svc(over: Partial<SwarmServiceInfo> & { name: string; image: string }): SwarmServiceInfo {
  return {
    id: `id-${over.name}`,
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': over.name.split('_')[0]! },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    ...over,
  } as SwarmServiceInfo;
}

const WP_DB = svc({
  name: 'wp_db',
  image: 'mariadb:11',
  env: ['MARIADB_ROOT_PASSWORD_FILE=/run/secrets/db_root', 'MARIADB_DATABASE=wordpress'],
  mounts: [{ type: 'volume', source: 'wp_db-data', target: '/var/lib/mysql' }],
} as never);
const CACHE = svc({
  name: 'wp_cache',
  image: 'redis:7-alpine',
  desiredReplicas: 1,
  mounts: [{ type: 'volume', source: 'wp_cache-data', target: '/data' }],
} as never);
const LOCKED = svc({
  name: 'shop_db',
  image: 'mysql:8.4',
  env: ['MYSQL_RANDOM_ROOT_PASSWORD=1'],
  mounts: [{ type: 'volume', source: 'shop_db-data', target: '/var/lib/mysql' }],
} as never);
const PG = svc({
  name: 'blog_pg',
  image: 'postgres:16',
  mounts: [{ type: 'volume', source: 'blog_pg-data', target: '/var/lib/postgresql/data' }],
} as never);

describe('detectAppDbs', () => {
  it('keeps the dumpable engines, with mount + credential resolution', () => {
    const dbs = detectAppDbs([WP_DB, CACHE, LOCKED, PG]);
    expect(dbs.map((d) => [d.service, d.engine, d.volume, d.dataMount, d.creds.ok])).toEqual([
      ['blog_pg', 'postgres', 'blog_pg-data', '/var/lib/postgresql/data', false],
      ['shop_db', 'mysql', 'shop_db-data', '/var/lib/mysql', false],
      ['wp_cache', 'redis', 'wp_cache-data', '/data', true],
      ['wp_db', 'mariadb', 'wp_db-data', '/var/lib/mysql', true],
    ]);
  });
});

describe('checkRestorePreconditions (throw before anything is touched)', () => {
  const [locked, cache, wp] = detectAppDbs([WP_DB, CACHE, LOCKED]);
  it('in-place needs the service name typed back', () => {
    expect(() => checkRestorePreconditions(wp!, { mode: 'in-place', confirm: 'wp' })).toThrow('type wp_db to confirm');
    expect(() => checkRestorePreconditions(wp!, { mode: 'in-place', confirm: ' wp_db ' })).not.toThrow();
    expect(() => checkRestorePreconditions(wp!, { mode: 'copy' })).not.toThrow();
  });
  it('SQL restores need credentials; a Redis copy does not', () => {
    expect(() => checkRestorePreconditions(locked!, { mode: 'copy' })).toThrow("can't log into the server");
    expect(() => checkRestorePreconditions(cache!, { mode: 'copy' })).not.toThrow();
  });
});

describe('coverageFor / copyVolumeName', () => {
  const [locked, , wp] = detectAppDbs([WP_DB, CACHE, LOCKED]);
  it('says volume-only with the reason when credentials are unresolved', () => {
    expect(coverageFor(locked!, undefined)).toEqual({
      mode: 'volume-only',
      method: 'mysqldump',
      note: 'volume snapshot only — the root password is random and no MYSQL_USER/MYSQL_PASSWORD is set',
      lastAt: null,
      lastStatus: null,
      lastError: null,
      lastSnapshotId: null,
    });
  });
  it('folds the latest audit row', () => {
    const at = new Date('2026-09-24T03:12:00Z');
    expect(coverageFor(wp!, { targetId: 'wp/wp_db', ts: at, metadata: { status: 'succeeded', snapshotId: 'abc' } })).toMatchObject({
      mode: 'logical',
      method: 'mariadb-dump',
      lastAt: '2026-09-24T03:12:00.000Z',
      lastStatus: 'succeeded',
      lastSnapshotId: 'abc',
    });
    expect(coverageFor(wp!, { targetId: 'wp/wp_db', ts: at, metadata: { status: 'failed', error: 'Access denied' } }).lastError).toBe('Access denied');
  });
  it('names a Redis copy volume', () => {
    expect(copyVolumeName('wp_cache-data', 'copy_202609241530')).toBe('wp_cache-data-copy-202609241530');
  });
});

// ── orchestration against an in-memory hub ───────────────────────────────────

function world(services: SwarmServiceInfo[], opts: { appendonly?: boolean; failBackup?: boolean } = {}) {
  const calls: Array<{ node: string; cmd: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  let running = new Set(services.map((s) => s.name));
  const containers = () =>
    services
      .filter((s) => running.has(s.name))
      .map((s) => ({ id: `c-${s.name}`, serviceId: s.id, state: 'running', labels: {}, name: s.name, image: s.image, nodeId: 'n-db' }));
  const hub = {
    managerNode: () => 'n-mgr',
    isOnline: () => true,
    onlineNodeIds: () => ['n-db'],
    latestContainers: () => containers(),
    liveInventory: () => ({ services, containers: containers() }),
    dispatch: async (node: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ node, cmd, payload });
      if (cmd === 'service.scale') {
        const next = new Set(running);
        if (payload.replicas === 0) next.delete(payload.service as string);
        else next.add(payload.service as string);
        running = next;
        return {};
      }
      if (cmd === 'appdb.backup') {
        if (opts.failBackup) throw new Error('Access denied for user root');
        return { snapshotId: 'safe1', engine: payload.engine, sizeBytes: 5, databases: ['wordpress'], appendonly: opts.appendonly ?? false };
      }
      if (cmd === 'appdb.restore') {
        return { mode: payload.mode, engine: payload.engine, databases: ['wordpress'], volume: payload.copyVolume ?? payload.dataVolume };
      }
      return {};
    },
  };
  const target = {
    id: 't1', name: 'swarmy-object-storage', kind: 'S3', endpoint: 'http://swarmy-garage:3900', bucket: 'b', prefix: null,
    region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true, createdAt: new Date(0),
  };
  const db = {
    organization: { findMany: async () => [{ id: 'org1' }] },
    auditLog: {
      create: async (a: { data: { action: string; metadata: Record<string, unknown> } }) => {
        audits.push({ action: a.data.action, metadata: a.data.metadata });
        return {};
      },
      findMany: async () => [],
    },
  };
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: 'org1', session: null, reqHeaders: new Headers() } as unknown as OrgContext;
  // Targets live in the org's swarm (swarm-kv).
  seedKvRows(ctx.hub, 'org1', 'bkp-target', [target]);
  return { ctx, calls, audits, deps: { db, hub, auth: {} } as never, isRunning: (n: string) => running.has(n) };
}

describe('runAppDbBackup', () => {
  it('dispatches to the node running the task, on the overlay, with probe recipe + tags', async () => {
    const w = world([WP_DB]);
    const r = await runAppDbBackup(w.ctx, { stack: 'wp', service: 'wp_db', reason: 'manual' });
    expect(r.snapshotId).toBe('safe1');
    const c = w.calls.find((x) => x.cmd === 'appdb.backup')!;
    expect(c.node).toBe('n-db');
    expect(c.payload.network).toBe('swarmy');
    expect(c.payload.host).toBe('appdb-wp_db');
    expect(c.payload.tags).toEqual(['org:org1', 'appdb:wp/wp_db', 'engine:mariadb', 'reason:manual']);
    expect((c.payload.creds as { password: unknown }).password).toEqual([{ kind: 'file', name: 'MARIADB_ROOT_PASSWORD_FILE' }]);
    // no secret VALUE ever rides the wire — only the recipe
    expect(JSON.stringify(c.payload.creds)).not.toContain('/run/secrets');
    expect(w.audits.map((a) => [a.action, a.metadata.status])).toEqual([['appdb.backup', 'succeeded']]);
  });

  it('refuses (and says the volume copy still covers it) when credentials are unresolved', async () => {
    const w = world([LOCKED]);
    await expect(runAppDbBackup(w.ctx, { stack: 'shop', service: 'shop_db', reason: 'manual' })).rejects.toThrow(
      'its volume snapshot still covers it',
    );
    expect(w.calls).toEqual([]);
  });

  it('the scheduler hook dumps matching volumes and skips the rest', async () => {
    const w = world([WP_DB, LOCKED, PG]);
    const base = { orgId: 'org1', targetId: 't1', retentionDays: 7 };
    expect(await runScheduledAppDbDump(w.deps, { ...base, volume: 'wp_db-data' })).toBe('dumped');
    expect(await runScheduledAppDbDump(w.deps, { ...base, volume: 'shop_db-data' })).toBe('skipped');
    // compose Postgres without a password in its env: volume-only
    expect(await runScheduledAppDbDump(w.deps, { ...base, volume: 'blog_pg-data' })).toBe('skipped');
    const dumps = w.calls.filter((c) => c.cmd === 'appdb.backup');
    expect(dumps).toHaveLength(1);
    expect(dumps[0]!.payload.retentionDays).toBe(7);
    expect((dumps[0]!.payload.tags as string[]).at(-1)).toBe('reason:scheduled');
  });
});

describe('restoreAppDb', () => {
  it('copy: no safety dump, loads into the running server', async () => {
    const w = world([WP_DB]);
    const r = await restoreAppDb(w.ctx, { stack: 'wp', service: 'wp_db', snapshotId: 'abc', mode: 'copy' });
    expect(w.calls.map((c) => c.cmd)).toEqual(['appdb.restore']);
    expect(w.calls[0]!.payload.suffix).toMatch(/^copy_\d{12}$/);
    expect(r.safetySnapshotId).toBeNull();
  });

  it('in-place SQL: safety dump first, then load; aborts untouched when the safety dump fails', async () => {
    const ok = world([WP_DB]);
    const r = await restoreAppDb(ok.ctx, { stack: 'wp', service: 'wp_db', snapshotId: 'abc', mode: 'in-place', confirm: 'wp_db' });
    expect(ok.calls.map((c) => c.cmd)).toEqual(['appdb.backup', 'appdb.restore']);
    expect((ok.calls[0]!.payload.tags as string[]).at(-1)).toBe('reason:pre-restore');
    expect(r.safetySnapshotId).toBe('safe1');

    const bad = world([WP_DB], { failBackup: true });
    await expect(
      restoreAppDb(bad.ctx, { stack: 'wp', service: 'wp_db', snapshotId: 'abc', mode: 'in-place', confirm: 'wp_db' }),
    ).rejects.toThrow('the pre-restore safety dump failed, so nothing was changed');
    expect(bad.calls.map((c) => c.cmd)).toEqual(['appdb.backup']);
  });

  it('in-place Redis: safety dump → scale 0 → place RDB on the volume node → scale back', async () => {
    const w = world([CACHE]);
    await restoreAppDb(w.ctx, { stack: 'wp', service: 'wp_cache', snapshotId: 'abc', mode: 'in-place', confirm: 'wp_cache' });
    expect(w.calls.map((c) => [c.cmd, c.node])).toEqual([
      ['appdb.backup', 'n-db'],
      ['service.scale', 'n-mgr'],
      ['appdb.restore', 'n-db'],
      ['service.scale', 'n-mgr'],
    ]);
    expect(w.calls[1]!.payload.replicas).toBe(0);
    expect(w.calls[3]!.payload.replicas).toBe(1);
    expect(w.calls[2]!.payload.dataVolume).toBe('wp_cache-data');
    expect(w.isRunning('wp_cache')).toBe(true);
  });

  it('in-place Redis with AOF on is refused before the service is stopped', async () => {
    const w = world([CACHE], { appendonly: true });
    await expect(
      restoreAppDb(w.ctx, { stack: 'wp', service: 'wp_cache', snapshotId: 'abc', mode: 'in-place', confirm: 'wp_cache' }),
    ).rejects.toThrow('appendonly yes');
    expect(w.calls.map((c) => c.cmd)).toEqual(['appdb.backup']);
  });

  it('Redis copy writes a new volume', async () => {
    const w = world([CACHE]);
    const r = await restoreAppDb(w.ctx, { stack: 'wp', service: 'wp_cache', snapshotId: 'abc', mode: 'copy' });
    expect(r.volume).toMatch(/^wp_cache-data-copy-\d{12}$/);
    expect(w.calls.map((c) => c.cmd)).toEqual(['appdb.restore']);
  });
});
