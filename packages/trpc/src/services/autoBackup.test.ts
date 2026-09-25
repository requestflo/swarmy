import { peekKvRows, seedKvRows } from './swarm-kv.service';
import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  AUTO_NATIVE_TARGET_NAME,
  DB_BACKUP_AUTO_LABEL,
  chooseAutoBackupTarget,
  chooseAutoSecondaryTarget,
  detectBackupVolumes,
  nextExcludeLabel,
  volumeAutoOptOut,
  detectDbEngine,
  detectDbServices,
  planManagedAutoSchedule,
  shouldCreateVolumeSchedule,
  staggeredAnchor,
  staggeredCron,
  staggeredSlot,
} from './autoBackup';
import { autoBackupCoverage, ensureAutoBackupsForOrg, setAutoVolumeBackup } from './autoBackup.service';
import { NATIVE_TARGET_NAME } from './backups.service';
import { encodeScheduleLabel, parseScheduleLabel } from './dbBackup.service';
import { provisionDb } from './manageddb.service';
import { removeSchedule, scheduleNextRunAt } from './backupSchedule.service';
import type { OrgContext } from '../context';

const T0 = '2026-01-01T00:00:00Z';

function svc(over: Partial<SwarmServiceInfo> & { name: string; image: string }): SwarmServiceInfo {
  return {
    id: over.name,
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: T0,
    updatedAt: T0,
    labels: {},
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    ...over,
  } as SwarmServiceInfo;
}

const wpDb = svc({
  name: 'wp_db',
  image: 'mariadb:11.4',
  labels: { 'com.docker.stack.namespace': 'wp' },
  mounts: [{ type: 'volume', source: 'wp_db-data', target: '/var/lib/mysql' }],
});

// ── detection ────────────────────────────────────────────────────────────────

describe('detectDbEngine — conservative image match', () => {
  it('matches the repo name across registries, tags and digests', () => {
    expect(detectDbEngine('mariadb:11')).toBe('mariadb');
    expect(detectDbEngine('docker.io/library/mysql:8.4@sha256:abc')).toBe('mysql');
    expect(detectDbEngine('postgres')).toBe('postgres');
    expect(detectDbEngine('bitnami/postgresql:16')).toBe('postgres');
    expect(detectDbEngine('registry.local:5000/mongo:7')).toBe('mongo');
    expect(detectDbEngine('valkey/valkey:8')).toBe('valkey');
    expect(detectDbEngine('redis:7-alpine')).toBe('redis');
  });
  it('does not match lookalikes', () => {
    expect(detectDbEngine('wordpress:6')).toBeNull();
    expect(detectDbEngine('prom/mysqld-exporter')).toBeNull();
    expect(detectDbEngine('rediscommander/redis-commander')).toBeNull();
    expect(detectDbEngine('postgres-exporter:1')).toBeNull();
    expect(detectDbEngine('redis.example.com:5000/app')).toBeNull();
  });
});

describe('detectDbServices — DB services with a named data volume', () => {
  it('finds the WordPress blueprint MariaDB on wp_db-data', () => {
    const web = svc({
      name: 'wp_web',
      image: 'wordpress:6',
      labels: { 'com.docker.stack.namespace': 'wp' },
      mounts: [{ type: 'volume', source: 'wp_wp-content', target: '/var/www/html' }],
    });
    expect(detectDbServices([web, wpDb])).toEqual([
      { stack: 'wp', service: 'wp_db', engine: 'mariadb', volume: 'wp_db-data' },
    ]);
  });

  it('detects a compose DB even though every compose service is labelled swarmy.managed', () => {
    // Regression (live): deployFromCompose stamps swarmy.managed=true on all
    // services, and detection used to skip that label — so no user DB matched.
    const db = svc({
      name: 'wp_wp-db',
      image: 'mariadb:11.4',
      labels: { 'com.docker.stack.namespace': 'wp', 'swarmy.managed': 'true' },
      mounts: [{ type: 'volume', source: 'wp_wp-db-data', target: '/var/lib/mysql' }],
    });
    expect(detectDbServices([db])).toEqual([
      { stack: 'wp', service: 'wp_wp-db', engine: 'mariadb', volume: 'wp_wp-db-data' },
    ]);
  });

  it('prefers the engine data dir over other named volumes', () => {
    const pg = svc({
      name: 'app_pg',
      image: 'postgres:16',
      labels: { 'com.docker.stack.namespace': 'app' },
      mounts: [
        { type: 'volume', source: 'app_initdb', target: '/docker-entrypoint-initdb.d' },
        { type: 'volume', source: 'app_pg-data', target: '/var/lib/postgresql/data' },
      ],
    });
    expect(detectDbServices([pg])[0]?.volume).toBe('app_pg-data');
  });

  it('skips binds, anonymous volumes, managed data members and swarmy services', () => {
    const bind = svc({
      name: 'a_db',
      image: 'mysql:8',
      labels: { 'com.docker.stack.namespace': 'a' },
      mounts: [{ type: 'bind', source: '/srv/mysql', target: '/var/lib/mysql' }],
    });
    const anon = svc({
      name: 'b_db',
      image: 'mysql:8',
      labels: { 'com.docker.stack.namespace': 'b' },
      mounts: [{ type: 'volume', target: '/var/lib/mysql' }],
    });
    const managed = svc({
      name: 'c_main-primary',
      image: 'bitnamilegacy/postgresql:16',
      labels: { 'com.docker.stack.namespace': 'c', 'swarmy.db.cluster': 'main' },
      mounts: [{ type: 'volume', source: 'c_main-primary-data', target: '/bitnami/postgresql' }],
    });
    const cache = svc({
      name: 'c_cache',
      image: 'valkey/valkey:8',
      labels: { 'com.docker.stack.namespace': 'c', 'swarmy.cache.cluster': 'cache' },
      mounts: [{ type: 'volume', source: 'c_cache-data', target: '/data' }],
    });
    const noMounts = svc({
      name: 'd_db',
      image: 'redis:7',
      labels: { 'com.docker.stack.namespace': 'd' },
    });
    expect(detectDbServices([bind, anon, managed, cache, noMounts])).toEqual([]);
  });
});

describe('detectDbServices — managed queue caches are backed up like a DB', () => {
  it('includes a queue primary (noeviction job store) but not its replica or a plain cache', () => {
    const labels = {
      'com.docker.stack.namespace': 'shop',
      'swarmy.cache.cluster': 'jobs',
      'swarmy.cache.purpose': 'queue',
    };
    const primary = svc({
      name: 'shop_jobs-cache',
      image: 'valkey/valkey:8',
      labels: { ...labels, 'swarmy.cache.role': 'primary' },
      mounts: [{ type: 'volume', source: 'shop_jobs-cache-data', target: '/data' }],
    });
    const replica = svc({
      name: 'shop_jobs-cache-replica',
      image: 'valkey/valkey:8',
      labels: { ...labels, 'swarmy.cache.role': 'replica' },
      mounts: [{ type: 'volume', source: 'shop_jobs-cache-data', target: '/data' }],
    });
    expect(detectDbServices([primary, replica])).toEqual([
      { stack: 'shop', service: 'shop_jobs-cache', engine: 'valkey', volume: 'shop_jobs-cache-data' },
    ]);
  });
});

// ── destination choice ──────────────────────────────────────────────────────

describe('chooseAutoBackupTarget — native store → off-box S3 → node path → none', () => {
  const s3 = { id: 's3', name: 'offsite', kind: 'S3', enabled: true, createdAt: '2026-01-01' };
  const node = { id: 'n', name: 'disk', kind: 'NODE', enabled: true, createdAt: '2025-01-01' };
  const native = {
    id: 'nat',
    name: AUTO_NATIVE_TARGET_NAME,
    kind: 'S3',
    enabled: true,
    createdAt: '2026-06-01',
  };

  it('keeps the native name in lockstep with backups.service', () => {
    expect(AUTO_NATIVE_TARGET_NAME).toBe(NATIVE_TARGET_NAME);
  });
  it('prefers the native object store when enabled', () => {
    expect(chooseAutoBackupTarget([node, s3, native])?.id).toBe('nat');
  });
  it('falls back to S3 when native is disabled, then node path, then none', () => {
    expect(chooseAutoBackupTarget([node, s3, { ...native, enabled: false }])?.id).toBe('s3');
    expect(chooseAutoBackupTarget([node, { ...s3, enabled: false }])?.id).toBe('n');
    expect(chooseAutoBackupTarget([{ ...node, enabled: false }])).toBeNull();
    expect(chooseAutoBackupTarget([])).toBeNull();
  });
  it('is stable: the oldest target in a tier wins', () => {
    const older = { ...s3, id: 's3-old', createdAt: '2024-01-01' };
    expect(chooseAutoBackupTarget([s3, older])?.id).toBe('s3-old');
  });
});

// ── stagger ─────────────────────────────────────────────────────────────────

describe('staggered nightly slot — 02:00–04:59 UTC, deterministic', () => {
  it('is stable per key and always inside the window', () => {
    expect(staggeredSlot('wp/wp_db-data')).toEqual(staggeredSlot('wp/wp_db-data'));
    for (let i = 0; i < 500; i++) {
      const { hour, minute } = staggeredSlot(`stack-${i}/db`);
      expect(hour).toBeGreaterThanOrEqual(2);
      expect(hour).toBeLessThanOrEqual(4);
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThanOrEqual(59);
    }
  });
  it('spreads different keys across the window (no thundering herd)', () => {
    const slots = new Set<string>();
    for (let i = 0; i < 100; i++) slots.add(staggeredCron(`s${i}/main`));
    expect(slots.size).toBeGreaterThan(60);
  });
  it('the cron and the interval anchor agree', () => {
    const { hour, minute } = staggeredSlot('shop/main');
    expect(staggeredCron('shop/main')).toBe(`${minute} ${hour} * * *`);
    const anchor = staggeredAnchor('shop/main', new Date('2026-09-23T17:12:00Z'));
    expect(anchor.toISOString()).toBe(
      new Date(Date.UTC(2026, 8, 23, hour, minute)).toISOString(),
    );
  });
});

// ── planning: never override, respect opt-out ──────────────────────────────

describe('planManagedAutoSchedule', () => {
  const base = {
    stack: 'shop',
    cluster: 'main',
    labels: {},
    schedule: null,
    target: { id: 't1' },
    enabledTargetIds: new Set(['t1']),
  };
  it('stamps an unscheduled cluster', () => {
    expect(planManagedAutoSchedule(base)).toEqual({
      action: 'stamp',
      targetId: 't1',
      cron: staggeredCron('shop/main'),
      repoint: false,
    });
  });
  it('never overrides a user schedule', () => {
    expect(planManagedAutoSchedule({ ...base, schedule: { targetId: 'x' } }).action).toBe('none');
  });
  it('respects the opt-out label', () => {
    const plan = planManagedAutoSchedule({ ...base, labels: { [DB_BACKUP_AUTO_LABEL]: 'off' } });
    expect(plan).toEqual({ action: 'none', reason: 'opted-out' });
  });
  it('leaves a healthy auto schedule alone, re-points one whose destination is gone', () => {
    expect(
      planManagedAutoSchedule({ ...base, schedule: { auto: true, targetId: 't1' } }).action,
    ).toBe('none');
    expect(planManagedAutoSchedule({ ...base, schedule: { auto: true, targetId: 'gone' } })).toMatchObject({
      action: 'stamp',
      targetId: 't1',
      repoint: true,
    });
  });
  it('does nothing without a destination, and never schedules drill clusters', () => {
    expect(planManagedAutoSchedule({ ...base, target: null })).toEqual({
      action: 'none',
      reason: 'no-destination',
    });
    expect(planManagedAutoSchedule({ ...base, cluster: 'drill-abc' }).action).toBe('none');
  });
});

describe('shouldCreateVolumeSchedule', () => {
  it('only when no row (user, auto or tombstone) exists for the volume', () => {
    expect(shouldCreateVolumeSchedule('wp_db-data', [])).toBe(true);
    expect(
      shouldCreateVolumeSchedule('wp_db-data', [{ volume: 'wp_db-data', auto: false, optedOutAt: null }]),
    ).toBe(false);
    expect(
      shouldCreateVolumeSchedule('wp_db-data', [
        { volume: 'wp_db-data', auto: true, optedOutAt: new Date() },
      ]),
    ).toBe(false);
    expect(
      shouldCreateVolumeSchedule('wp_db-data', [{ volume: 'other', auto: false, optedOutAt: null }]),
    ).toBe(true);
  });
});

describe('schedule label carries the auto marker', () => {
  it('round-trips auto: true and drops it for user schedules', () => {
    const auto = parseScheduleLabel(
      encodeScheduleLabel({ cron: '5 2 * * *', engine: 'pg_dump', retentionDays: 7, pitr: false, auto: true }),
    );
    expect(auto?.auto).toBe(true);
    const user = parseScheduleLabel(
      encodeScheduleLabel({ cron: '5 2 * * *', engine: 'pg_dump', retentionDays: 7, pitr: false }),
    );
    expect(user?.auto).toBeUndefined();
  });
});

// ── the loop (fake world) ───────────────────────────────────────────────────

interface World {
  ctx: OrgContext;
  dispatches: Array<{ cmd: string; payload: Record<string, unknown> }>;
  audits: Array<{ action: string; targetId: string; metadata: Record<string, unknown> }>;
  schedules: Array<Record<string, unknown>>;
}

function world(opts: {
  services: SwarmServiceInfo[];
  targets?: Array<{ id: string; name: string; kind: string; enabled: boolean; createdAt: Date }>;
  schedules?: Array<Record<string, unknown>>;
  /** Running task containers on node1 (so a volume's host node resolves). */
  containers?: Array<{ id: string; serviceId: string; state: string }>;
}): World {
  const dispatches: World['dispatches'] = [];
  const audits: World['audits'] = [];
  const schedules = opts.schedules ?? [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as object)) {
        return ((v as { in: unknown[] }).in).includes(row[k]);
      }
      return (row[k] ?? null) === v;
    });
  const db = {
    backupJob: { groupBy: () => Promise.resolve([]) },
    auditLog: {
      create: (a: { data: { action: string; targetId: string; metadata: Record<string, unknown> } }) => {
        audits.push({ action: a.data.action, targetId: a.data.targetId, metadata: a.data.metadata });
        return Promise.resolve({});
      },
    },
  };
  const hub = {
    managerNode: () => 'node1',
    isOnline: () => true,
    onlineNodeIds: () => ['node1'],
    latestContainers: () => opts.containers ?? [],
    nodeInventory: () => [],
    swarmNodeIdFor: () => 'swarm-node-1',
    liveInventory: () => ({ services: opts.services, containers: opts.containers ?? [] }),
    dispatch: (_n: string, cmd: string, payload: Record<string, unknown>) => {
      dispatches.push({ cmd, payload });
      return Promise.resolve({});
    },
  };
  const ctx = {
    db,
    hub,
    user: null,
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
  } as unknown as OrgContext;
  // Targets + schedules live in the org's swarm (swarm-kv); `schedules` reads it back live.
  seedKvRows(ctx.hub, 'org1', 'bkp-target', opts.targets ?? []);
  seedKvRows(ctx.hub, 'org1', 'bkp-sched', schedules);
  return {
    ctx,
    dispatches,
    audits,
    get schedules() {
      return peekKvRows(ctx.hub, 'org1', 'bkp-sched', ['createdAt', 'anchorAt', 'optedOutAt']);
    },
  };
}

const NOW = new Date('2026-09-23T12:00:00Z');
const target = { id: 'tgt', name: 'offsite', kind: 'S3', enabled: true, createdAt: new Date(T0) };
const managedPrimary = svc({
  name: 'shop_main-primary',
  image: 'bitnamilegacy/postgresql:16',
  labels: {
    'com.docker.stack.namespace': 'shop',
    'swarmy.db.cluster': 'main',
    'swarmy.db.role': 'primary',
    'swarmy.db.engine': 'postgres',
  },
});

describe('ensureAutoBackupsForOrg', () => {
  it('schedules the compose DB volume + the managed cluster, audited as backup.schedule.auto', async () => {
    const w = world({ services: [wpDb, managedPrimary], targets: [target] });
    const res = await ensureAutoBackupsForOrg(w.ctx, NOW);
    expect(res).toEqual({ destination: 'tgt', managedStamped: 1, volumeSchedulesCreated: 1, volumeSchedulesRetired: 0 });

    const row = w.schedules[0]!;
    expect(row).toMatchObject({
      volume: 'wp_db-data',
      targetId: 'tgt',
      every: 1,
      unit: 'days',
      auto: true,
      retentionDays: 7,
    });
    const anchor = row.anchorAt as Date;
    expect(anchor.getUTCHours()).toBeGreaterThanOrEqual(2);
    expect(anchor.getUTCHours()).toBeLessThanOrEqual(4);
    // No stored nextRunAt: the first slot is derived from the anchor.
    expect('nextRunAt' in row).toBe(false);
    const next = scheduleNextRunAt({ ...(row as Record<string, unknown>), createdAt: NOW } as never, null)!;
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());

    const stamp = w.dispatches.find((d) => d.cmd === 'service.updateLabels')!;
    expect(stamp.payload.service).toBe('shop_main-primary');
    const label = parseScheduleLabel(
      (stamp.payload.add as Record<string, string>)['swarmy.db.backup.schedule'],
    );
    expect(label).toMatchObject({
      engine: 'pg_dump',
      retentionDays: 7,
      targetId: 'tgt',
      auto: true,
      cron: staggeredCron('shop/main'),
    });

    const autos = w.audits.filter((a) => a.action === 'backup.schedule.auto');
    expect(autos.map((a) => a.metadata.kind).sort()).toEqual(['managed', 'volume']);
    expect(autos.find((a) => a.metadata.kind === 'volume')?.metadata.consistency).toBe(
      'crash-consistent',
    );
  });

  it('is idempotent: a second sweep creates nothing', async () => {
    const w = world({ services: [wpDb], targets: [target] });
    await ensureAutoBackupsForOrg(w.ctx, NOW);
    const again = await ensureAutoBackupsForOrg(w.ctx, NOW);
    expect(again.volumeSchedulesCreated).toBe(0);
    expect(w.schedules).toHaveLength(1);
  });

  it('no destination: creates nothing, does not throw', async () => {
    const w = world({ services: [wpDb, managedPrimary], targets: [] });
    const res = await ensureAutoBackupsForOrg(w.ctx, NOW);
    expect(res).toEqual({ destination: null, managedStamped: 0, volumeSchedulesCreated: 0, volumeSchedulesRetired: 0 });
    expect(w.dispatches).toHaveLength(0);
    expect(w.schedules).toHaveLength(0);
    expect(w.audits).toHaveLength(0);
  });

  it('never overrides a user volume schedule or a managed user schedule', async () => {
    const userPrimary = svc({
      ...managedPrimary,
      labels: {
        ...managedPrimary.labels,
        'swarmy.db.backup.schedule': encodeScheduleLabel({
          cron: '0 1 * * *',
          engine: 'pg_dumpall',
          retentionDays: 30,
          pitr: false,
        }),
      },
    });
    const w = world({
      services: [wpDb, userPrimary],
      targets: [target],
      schedules: [{ id: 'mine', volume: 'wp_db-data', auto: false, optedOutAt: null, orgId: 'org1' }],
    });
    const res = await ensureAutoBackupsForOrg(w.ctx, NOW);
    expect(res.managedStamped).toBe(0);
    expect(res.volumeSchedulesCreated).toBe(0);
    expect(w.dispatches).toHaveLength(0);
  });

  it('opt-out: removing an auto schedule tombstones it and the loop does not re-create it', async () => {
    const w = world({ services: [wpDb], targets: [target] });
    await ensureAutoBackupsForOrg(w.ctx, NOW);
    const id = w.schedules[0]!.id as string;
    await removeSchedule(w.ctx, id);
    expect(w.schedules).toHaveLength(1); // kept as a tombstone, not deleted
    expect(w.schedules[0]!.optedOutAt).toBeInstanceOf(Date);
    expect(w.schedules[0]!.paused).toBe(true);

    const again = await ensureAutoBackupsForOrg(w.ctx, new Date(NOW.getTime() + 86_400_000));
    expect(again.volumeSchedulesCreated).toBe(0);
    expect(w.schedules).toHaveLength(1);

    // a managed cluster the user cleared carries the opt-out label
    const cleared = svc({
      ...managedPrimary,
      labels: { ...managedPrimary.labels, [DB_BACKUP_AUTO_LABEL]: 'off' },
    });
    const w2 = world({ services: [cleared], targets: [target] });
    expect((await ensureAutoBackupsForOrg(w2.ctx, NOW)).managedStamped).toBe(0);
  });

  it('a destination added later picks up the unscheduled DB', async () => {
    const w = world({ services: [wpDb], targets: [] });
    expect((await ensureAutoBackupsForOrg(w.ctx, NOW)).volumeSchedulesCreated).toBe(0);
    const w2 = world({ services: [wpDb], targets: [target], schedules: w.schedules });
    expect((await ensureAutoBackupsForOrg(w2.ctx, NOW)).volumeSchedulesCreated).toBe(1);
  });
});

// ── managed Postgres provision is born with its schedule ────────────────────

describe('provisionDb — default-on backup schedule', () => {
  it('stamps an auto pg_dump schedule on the new primary and audits it', async () => {
    const w = world({ services: [], targets: [target] });
    await provisionDb(w.ctx, { stack: 'shop', name: 'main', replicas: 0 });
    const primaryDeploy = w.dispatches.find(
      (d) =>
        d.cmd === 'service.deploy' &&
        (d.payload.spec as { name: string }).name === 'shop_main-primary',
    )!;
    const labels = (primaryDeploy.payload.spec as { labels: Record<string, string> }).labels;
    expect(parseScheduleLabel(labels['swarmy.db.backup.schedule'])).toMatchObject({
      engine: 'pg_dump',
      retentionDays: 7,
      targetId: 'tgt',
      auto: true,
      cron: staggeredCron('shop/main'),
    });
    const audit = w.audits.find((a) => a.action === 'backup.schedule.auto');
    expect(audit?.targetId).toBe('shop/main');
  });

  it('no destination → provisions fine with no schedule; autoBackup:false opts out', async () => {
    const w = world({ services: [], targets: [] });
    await provisionDb(w.ctx, { stack: 'shop', name: 'main', replicas: 0 });
    const spec = w.dispatches.find((d) => d.cmd === 'service.deploy')!.payload.spec as {
      labels: Record<string, string>;
    };
    expect(spec.labels['swarmy.db.backup.schedule']).toBeUndefined();

    const w2 = world({ services: [], targets: [target] });
    await provisionDb(w2.ctx, { stack: 'shop', name: 'drill-x', replicas: 0, autoBackup: false });
    const spec2 = w2.dispatches.find((d) => d.cmd === 'service.deploy')!.payload.spec as {
      labels: Record<string, string>;
    };
    expect(spec2.labels['swarmy.db.backup.schedule']).toBeUndefined();
    expect(w2.audits.filter((a) => a.action === 'backup.schedule.auto')).toHaveLength(0);
  });
});

// ── every named volume (plans/epic-volume-mobility.md §5.2) ──────────────────

const blogWeb = svc({
  name: 'blog_web',
  image: 'ghost:5',
  labels: { 'com.docker.stack.namespace': 'blog' },
  mounts: [
    { type: 'volume', source: 'blog_content', target: '/var/lib/ghost/content' },
    { type: 'volume', source: 'blog_cache', target: '/cache' },
    { type: 'bind', source: '/srv/blog', target: '/srv' },
  ],
});
const blogTask = { id: 'c-blog', serviceId: 'blog_web', state: 'running' };
const native = { id: 'nat', name: NATIVE_TARGET_NAME, kind: 'S3', enabled: true, createdAt: new Date(T0) };
const offsite = { id: 'off', name: 'offsite', kind: 'S3', enabled: true, createdAt: new Date('2026-02-01T00:00:00Z') };

describe('detectBackupVolumes (pure)', () => {
  it('every named volume of an app, DBs first; binds, plumbing, managed members and per-node volumes are skipped', () => {
    const scaled = svc({ name: 'blog_worker', image: 'x', desiredReplicas: 3, labels: { 'com.docker.stack.namespace': 'blog' }, mounts: [{ type: 'volume', source: 'blog_tmp', target: '/t' }] });
    const global = svc({ name: 'blog_agent', image: 'x', mode: 'global', labels: { 'com.docker.stack.namespace': 'blog' }, mounts: [{ type: 'volume', source: 'blog_g', target: '/g' }] });
    const cache = svc({ name: 'blog_c-primary', image: 'valkey/valkey:8', labels: { 'com.docker.stack.namespace': 'blog', 'swarmy.cache.cluster': 'c' }, mounts: [{ type: 'volume', source: 'blog_c-data', target: '/data' }] });
    const sys = svc({ name: 'swarmy-garage', image: 'garage', labels: { 'com.docker.stack.namespace': 'swarmy-system' }, mounts: [{ type: 'volume', source: 'garage-data', target: '/d' }] });
    const got = detectBackupVolumes([blogWeb, wpDb, scaled, global, cache, sys]);
    expect(got.map((v) => [v.volume, v.engine])).toEqual([
      ['wp_db-data', 'mariadb'],
      ['blog_cache', null],
      ['blog_content', null],
    ]);
  });

  it('opt-out labels: the whole app, or one volume by short or full name', () => {
    const v = { stack: 'blog', service: 'blog_web', volume: 'blog_cache', engine: null };
    expect(volumeAutoOptOut(v, [{ labels: {} }])).toBeNull();
    expect(volumeAutoOptOut(v, [{ labels: {} }, { labels: { 'swarmy.backup.auto': 'OFF' } }])).toBe('app');
    expect(volumeAutoOptOut(v, [{ labels: { 'swarmy.backup.auto.exclude': 'uploads, cache' } }])).toBe('volume');
    expect(volumeAutoOptOut(v, [{ labels: { 'swarmy.backup.auto.exclude': 'blog_cache' } }])).toBe('volume');
    expect(volumeAutoOptOut(v, [{ labels: { 'swarmy.backup.auto.exclude': 'blog_cachex' } }])).toBeNull();
  });

  it('nextExcludeLabel adds/removes one volume and drops an empty label', () => {
    expect(nextExcludeLabel(undefined, 'blog_cache', 'blog', true)).toBe('cache');
    expect(nextExcludeLabel('uploads', 'blog_cache', 'blog', true)).toBe('cache,uploads');
    expect(nextExcludeLabel('cache,uploads', 'blog_cache', 'blog', false)).toBe('uploads');
    expect(nextExcludeLabel('blog_cache', 'blog_cache', 'blog', false)).toBeNull();
  });

  it('secondary: an off-box S3 copy only when the primary is the native Garage store', () => {
    const node = { id: 'n', name: 'disk', kind: 'NODE', enabled: true, createdAt: new Date(T0) };
    expect(chooseAutoSecondaryTarget([native, offsite, node], native)?.id).toBe('off');
    expect(chooseAutoSecondaryTarget([native, node], native)).toBeNull();
    expect(chooseAutoSecondaryTarget([offsite], offsite)).toBeNull();
    expect(chooseAutoSecondaryTarget([native, { ...offsite, enabled: false }], native)).toBeNull();
  });
});

describe('ensureAutoBackupsForOrg — every named volume', () => {
  it('schedules each named volume nightly to native Garage, also copied off-box, audited', async () => {
    const w = world({ services: [blogWeb], targets: [native, offsite], containers: [blogTask] });
    const res = await ensureAutoBackupsForOrg(w.ctx, NOW);
    expect(res.volumeSchedulesCreated).toBe(2);
    const rows = w.schedules.sort((a, b) => String(a.volume).localeCompare(String(b.volume)));
    expect(rows.map((r) => [r.volume, r.targetId, r.secondaryTargetId, r.nodeId, r.auto])).toEqual([
      ['blog_cache', 'nat', 'off', 'node1', true],
      ['blog_content', 'nat', 'off', 'node1', true],
    ]);
    expect(w.audits.filter((a) => a.action === 'backup.schedule.auto')).toHaveLength(2);
    // Steady state: a second sweep writes nothing.
    expect((await ensureAutoBackupsForOrg(w.ctx, NOW)).volumeSchedulesCreated).toBe(0);
  });

  it('a plain volume with no running task waits (never backs up a manager\'s empty copy)', async () => {
    const w = world({ services: [blogWeb], targets: [native] });
    expect((await ensureAutoBackupsForOrg(w.ctx, NOW)).volumeSchedulesCreated).toBe(0);
  });

  it('back-fills the off-box copy on an auto row made before the S3 target existed', async () => {
    const w = world({
      services: [blogWeb],
      targets: [native, offsite],
      containers: [blogTask],
      schedules: [
        { id: 's1', orgId: 'org1', targetId: 'nat', secondaryTargetId: null, volume: 'blog_content', nodeId: 'node1', every: 1, unit: 'days', paused: false, auto: true, retentionDays: 7, createdAt: new Date(T0), anchorAt: null, optedOutAt: null },
        { id: 's2', orgId: 'org1', targetId: 'nat', secondaryTargetId: null, volume: 'blog_cache', nodeId: 'node1', every: 1, unit: 'days', paused: false, auto: false, retentionDays: 7, createdAt: new Date(T0), anchorAt: null, optedOutAt: null },
      ],
    });
    await ensureAutoBackupsForOrg(w.ctx, NOW);
    const byId = new Map(w.schedules.map((r) => [r.id, r]));
    expect(byId.get('s1')!.secondaryTargetId).toBe('off');
    expect(byId.get('s2')!.secondaryTargetId).toBeNull(); // a user schedule is theirs
  });

  it('app opt-out label retires the auto rows (user rows kept); a tombstone still opts one volume out', async () => {
    const off = svc({ ...blogWeb, labels: { ...blogWeb.labels, 'swarmy.backup.auto': 'off' } });
    const w = world({
      services: [off],
      targets: [native],
      containers: [blogTask],
      schedules: [
        { id: 'a1', orgId: 'org1', targetId: 'nat', volume: 'blog_content', nodeId: 'node1', every: 1, unit: 'days', paused: false, auto: true, retentionDays: 7, createdAt: new Date(T0), anchorAt: null, optedOutAt: null },
        { id: 'u1', orgId: 'org1', targetId: 'nat', volume: 'blog_cache', nodeId: 'node1', every: 1, unit: 'days', paused: false, auto: false, retentionDays: 7, createdAt: new Date(T0), anchorAt: null, optedOutAt: null },
      ],
    });
    const res = await ensureAutoBackupsForOrg(w.ctx, NOW);
    expect(res).toMatchObject({ volumeSchedulesCreated: 0, volumeSchedulesRetired: 1 });
    expect(w.schedules.map((r) => r.id)).toEqual(['u1']);

    const t = world({
      services: [blogWeb],
      targets: [native],
      containers: [blogTask],
      schedules: [
        { id: 't1', orgId: 'org1', targetId: 'nat', volume: 'blog_cache', nodeId: 'node1', every: 1, unit: 'days', paused: true, auto: true, retentionDays: 7, createdAt: new Date(T0), anchorAt: null, optedOutAt: new Date(T0) },
      ],
    });
    await ensureAutoBackupsForOrg(t.ctx, NOW);
    expect(t.schedules.filter((r) => r.volume === 'blog_cache')).toHaveLength(1); // only the tombstone
    expect(t.schedules.filter((r) => r.volume === 'blog_content')).toHaveLength(1);
  });

  it('coverage lists plain volumes with their opt-out state', async () => {
    const ex = svc({ ...blogWeb, labels: { ...blogWeb.labels, 'swarmy.backup.auto.exclude': 'cache' } });
    const w = world({ services: [ex], targets: [native, offsite], containers: [blogTask] });
    await ensureAutoBackupsForOrg(w.ctx, NOW);
    const cov = await autoBackupCoverage(w.ctx, 'blog');
    expect(cov.appOptedOut).toBe(false);
    expect(cov.volumes.map((v) => [v.volume, v.status, v.optOut, v.secondaryTargetId])).toEqual([
      ['blog_cache', 'opted-out', 'volume', null],
      ['blog_content', 'auto', null, 'off'],
    ]);
  });
});

describe('setAutoVolumeBackup', () => {
  it('app off/on stamps and removes swarmy.backup.auto on every stack service, audited', async () => {
    const w = world({ services: [blogWeb], targets: [native] });
    await setAutoVolumeBackup(w.ctx, { stack: 'blog', enabled: false });
    expect(w.dispatches.at(-1)).toEqual({
      cmd: 'service.updateLabels',
      payload: { service: 'blog_web', add: { 'swarmy.backup.auto': 'off' }, removeKeys: [] },
    });
    expect(w.audits.at(-1)).toMatchObject({ action: 'backup.auto.set', targetId: 'blog' });

    const on = world({ services: [svc({ ...blogWeb, labels: { ...blogWeb.labels, 'swarmy.backup.auto': 'off' } })], targets: [native] });
    await setAutoVolumeBackup(on.ctx, { stack: 'blog', enabled: true });
    expect(on.dispatches.at(-1)!.payload).toEqual({ service: 'blog_web', add: {}, removeKeys: ['swarmy.backup.auto'] });
  });

  it('one volume: edits the exclude label; turning it back on clears its tombstone', async () => {
    const w = world({
      services: [svc({ ...blogWeb, labels: { ...blogWeb.labels, 'swarmy.backup.auto.exclude': 'cache' } })],
      targets: [native],
      schedules: [
        { id: 't1', orgId: 'org1', targetId: 'nat', volume: 'blog_cache', nodeId: 'node1', every: 1, unit: 'days', paused: true, auto: true, retentionDays: 7, createdAt: new Date(T0), anchorAt: null, optedOutAt: new Date(T0) },
      ],
    });
    await setAutoVolumeBackup(w.ctx, { stack: 'blog', volume: 'blog_cache', enabled: true });
    expect(w.dispatches.at(-1)!.payload).toEqual({ service: 'blog_web', add: {}, removeKeys: ['swarmy.backup.auto.exclude'] });
    expect(w.schedules).toHaveLength(0);

    const x = world({ services: [blogWeb], targets: [native] });
    await setAutoVolumeBackup(x.ctx, { stack: 'blog', volume: 'blog_content', enabled: false });
    expect(x.dispatches.at(-1)!.payload).toEqual({ service: 'blog_web', add: { 'swarmy.backup.auto.exclude': 'content' }, removeKeys: [] });
  });

  it('unknown stack → not found', async () => {
    const w = world({ services: [], targets: [native] });
    await expect(setAutoVolumeBackup(w.ctx, { stack: 'nope', enabled: false })).rejects.toThrow();
  });
});
