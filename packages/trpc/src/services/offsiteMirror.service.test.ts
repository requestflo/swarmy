import { beforeEach, describe, expect, test } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import {
  BUCKET_MARKER,
  EXIT_MARKER,
  finishRun,
  getMirror,
  reapStaleRuns,
  restoreFromOffsite,
  runDueMirrors,
  saveMirror,
  startMirrorRun,
  STALE_RUN_MS,
  summarizeRun,
} from './offsiteMirror.service';
import { peekKvRows, seedKv, seedKvRows, shareKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

// ── a tiny in-memory prisma (just the operators these services use) ─────────

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v != null) return false;
    } else if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
    } else if (typeof cond === 'object') {
      const c = cond as { lte?: Date; gt?: Date };
      if (!(v instanceof Date)) return false;
      if (c.lte && !(v.getTime() <= c.lte.getTime())) return false;
      if (c.gt && !(v.getTime() > c.gt.getTime())) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

let seq = 0;
function table(defaults: () => Row = () => ({})) {
  const rows: Row[] = [];
  const sortDesc = (list: Row[], orderBy?: Record<string, 'asc' | 'desc'>) => {
    const key = orderBy && Object.keys(orderBy)[0];
    if (!key) return list;
    return [...list].sort((a, b) => {
      const d = (a[key] as Date).getTime() - (b[key] as Date).getTime();
      return orderBy![key] === 'desc' ? -d : d;
    });
  };
  return {
    rows,
    async create({ data }: { data: Row }): Promise<Row> {
      const row: Row = { id: `id${++seq}`, ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    async findUnique({ where }: { where: Row }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findFirst({ where, orderBy }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'> }) {
      return sortDesc(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null;
    },
    async findMany(a: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'>; take?: number } = {}) {
      return sortDesc(rows.filter((r) => matches(r, a.where)), a.orderBy).slice(0, a.take ?? 1e9);
    },
    async count({ where }: { where?: Row }) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    async upsert({ where, create, update }: { where: Row; create: Row; update: Row }): Promise<Row> {
      const row = rows.find((r) => matches(r, where));
      if (row) return Object.assign(row, update);
      return this.create({ data: create });
    },
    async delete({ where }: { where: Row }) {
      const i = rows.findIndex((r) => matches(r, where));
      return rows.splice(i, 1)[0];
    },
  };
}

const ORG = 'org1';

function fakeDb() {
  return {
    offsiteMirrorRun: table(() => ({
      status: 'RUNNING',
      objectsCopied: 0,
      bytesCopied: 0n,
      deletes: 0,
      errorCount: 0,
      buckets: [],
      error: null,
      startedAt: new Date(),
      finishedAt: null,
    })),
    auditLog: table(() => ({ createdAt: new Date() })),
    organization: { findMany: async () => [{ id: ORG }] },
  };
}

type FakeDb = ReturnType<typeof fakeDb>;

interface Call {
  cmd: string;
  payload: { image: string; env: Record<string, string>; cmd: string[] };
}

/** Hub that answers Garage admin curls + the rclone one-shot. */
function fakeHub(opts: { manager?: string; rcloneOutput?: string; rcloneExit?: number } = {}) {
  const calls: Call[] = [];
  const hub = {
    calls,
    managerNode: () => opts.manager,
    isOnline: () => true,
    liveInventory: () => ({ services: [], containers: [] }),
    async dispatch(_node: string, cmd: string, payload: Call['payload']) {
      calls.push({ cmd, payload });
      const env = payload.env ?? {};
      if (payload.image.startsWith('rclone/')) {
        return { exitCode: opts.rcloneExit ?? 0, output: opts.rcloneOutput ?? '' };
      }
      if (env.GARAGE_BUCKET_IDS) {
        return {
          exitCode: 0,
          output: `${'__SWARMY_BUCKET__:'}b1\n${JSON.stringify({ id: 'b1', globalAliases: ['swarmy-backups'], objects: 3, bytes: 10 })}\n`,
        };
      }
      const url = env.GARAGE_URL ?? '';
      const ok = (body: unknown) => ({ exitCode: 0, output: `__SWARMY_STATUS__:200\n${JSON.stringify(body)}` });
      if (url.endsWith('/bucket?list')) return ok([{ id: 'b1' }]);
      if (url.endsWith('/key') && env.GARAGE_METHOD === 'POST') {
        return ok({ accessKeyId: 'GKmirror', secretAccessKey: 'mirror-secret', name: 'swarmy-offsite-mirror' });
      }
      if (url.endsWith('/bucket/allow')) return ok({});
      return ok({});
    },
  };
  return hub;
}

/**
 * The org's swarm (swarm-kv): Garage store config, backup targets and the
 * mirror live there. Every hub fake of one test world shares one in-memory
 * swarm (`swarmOf`); `seedTarget` / `seedStore` write into it.
 */
let currentSwarm: OrgContext['hub'] | undefined;

function ctxFor(db: FakeDb, hub: ReturnType<typeof fakeHub>, user: { id: string } | null = { id: 'u1' }) {
  const ctx = { db, hub, activeOrgId: ORG, user } as unknown as OrgContext;
  shareKv(ctx.hub, swarmHub(db));
  currentSwarm = swarmHub(db);
  return ctx;
}

/** A stand-in hub object that owns the world's in-memory swarm. */
const swarmHubs = new WeakMap<object, OrgContext['hub']>();
function swarmHub(db: FakeDb): OrgContext['hub'] {
  let h = swarmHubs.get(db);
  if (!h) {
    h = {} as OrgContext['hub'];
    useMemoryKv(h);
    swarmHubs.set(db, h);
  }
  return h;
}

/** Pin the mirror's creation time (its schedule anchor) the way the old fixture did. */
function pinMirrorCreatedAt(at = new Date('2026-09-01T00:00:00Z')): void {
  const { id, ...row } = mirrorRow();
  seedKvRows(currentSwarm, ORG, 'mirror', [{ ...row, id, createdAt: at }]);
}

/** The org's mirror document as a row (or undefined). */
function mirrorRow(): Record<string, unknown> {
  return peekKvRows(currentSwarm, ORG, 'mirror')[0]!;
}

async function seedTarget(db: FakeDb) {
  seedKvRows(swarmHub(db), ORG, 'bkp-target', [
    {
      id: 't1',
      name: 'b2-dr',
      kind: 'S3',
      endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      bucket: 'acme-dr',
      region: 'eu-central-003',
      credentialRef: encryptSecret('b2-key-id'),
      secretKeyRef: encryptSecret('b2-secret'),
      resticPasswordRef: encryptSecret('pw'),
      enabled: true,
      createdAt: new Date(),
    },
  ]);
  currentSwarm = swarmHub(db);
}

async function seedStore(db: FakeDb) {
  seedKv(swarmHub(db), ORG, 'storage', ORG, {
    enabled: true,
    driver: 'GARAGE',
    region: 'garage',
    adminTokenRef: encryptSecret('tok'),
    memberNodeIds: [],
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let db: FakeDb;
beforeEach(() => {
  db = fakeDb();
});

describe('run recording', () => {
  test('a mirror run records RUNNING, then closes with objects/bytes and audits', async () => {
    await seedTarget(db);
    await seedStore(db);
    const hub = fakeHub({
      manager: 'n1',
      rcloneOutput: [
        `${BUCKET_MARKER}swarmy-backups`,
        JSON.stringify({ level: 'notice', stats: { bytes: 4096, transfers: 3, deletes: 0, errors: 0 } }),
        `${EXIT_MARKER}0`,
      ].join('\n'),
    });
    const ctx = ctxFor(db, hub);
    await saveMirror(ctx, { targetId: 't1', allBuckets: true });

    const { runId, done } = await startMirrorRun(ctx, { trigger: 'manual' });
    const running = db.offsiteMirrorRun.rows.find((r) => r.id === runId)!;
    expect(running.direction).toBe('mirror');
    expect(running.hostNodeId).toBe('n1');
    await done;

    const run = db.offsiteMirrorRun.rows.find((r) => r.id === runId)!;
    expect(run.status).toBe('SUCCEEDED');
    expect(run.objectsCopied).toBe(3);
    expect(run.bytesCopied).toBe(4096n);
    expect(run.finishedAt).toBeInstanceOf(Date);

    // the mirror key was minted, stored encrypted, granted on the bucket
    const mirror = mirrorRow();
    expect(typeof mirror.sourceAccessKeyRef).toBe('string');
    expect(mirror.sourceAccessKeyRef).not.toContain('GKmirror');
    // grants are an in-memory cache (never a column); the last run is derived from history
    expect('grantedBucketIds' in mirror).toBe(false);
    const allows = () => hub.calls.filter((c) => c.payload.env?.GARAGE_URL?.endsWith('/bucket/allow')).length;
    expect(allows()).toBe(1);
    expect((await getMirror(ctx)).mirror?.lastRunAt).toBe((running.startedAt as Date).toISOString());

    // the rclone dispatch carries creds in env only
    const rclone = hub.calls.find((c) => c.payload.image.startsWith('rclone/'))!;
    expect(rclone.payload.env.RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY).toBe('mirror-secret');
    expect(rclone.payload.env.RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY).toBe('b2-secret');
    expect(JSON.stringify(rclone.payload.cmd)).not.toContain('secret');

    expect(db.auditLog.rows.map((r) => r.action)).toContain('offsite.mirror.run');
  });

  test('a second run is refused while one is in flight', async () => {
    await seedTarget(db);
    await seedStore(db);
    const ctx = ctxFor(db, fakeHub({ manager: 'n1' }));
    await saveMirror(ctx, { targetId: 't1', allBuckets: true });
    await db.offsiteMirrorRun.create({
      data: { orgId: ORG, mirrorId: mirrorRow().id, status: 'RUNNING', startedAt: new Date() },
    });
    await expect(startMirrorRun(ctx, { trigger: 'manual' })).rejects.toThrow(/already running/);
  });

  test('finishRun writes the summary onto the row', async () => {
    const run = await db.offsiteMirrorRun.create({ data: { orgId: ORG, mirrorId: 'm' } });
    const summary = summarizeRun({ exitCode: 1, output: `${BUCKET_MARKER}a1\n${EXIT_MARKER}1` });
    await finishRun(db as never, run.id as string, summary);
    expect(run.status).toBe('FAILED');
    expect(run.errorCount).toBe(1);
    expect(run.error).toMatch(/a1: rclone exited 1/);
  });

  test('orphaned RUNNING rows are reaped as FAILED', async () => {
    const now = new Date('2026-09-02T12:00:00Z');
    const old = await db.offsiteMirrorRun.create({
      data: { mirrorId: 'm', startedAt: new Date(now.getTime() - STALE_RUN_MS - 1000) },
    });
    const fresh = await db.offsiteMirrorRun.create({ data: { mirrorId: 'm', startedAt: now } });
    expect(await reapStaleRuns(db as never, now)).toBe(1);
    expect(old.status).toBe('FAILED');
    expect(fresh.status).toBe('RUNNING');
  });
});

describe('scheduler (runDueMirrors)', () => {
  test('a due mirror that cannot start still advances and records a FAILED run', async () => {
    await seedTarget(db); // no store row → object storage is off
    const hub = fakeHub({ manager: 'n1' });
    await saveMirror(ctxFor(db, hub), { targetId: 't1', allBuckets: true }); // never run → due
    pinMirrorCreatedAt();
    const now = new Date('2026-09-01T05:20:00Z');
    const res = await runDueMirrors({ db: db as never, hub: hub as never, auth: {} as never }, now);
    expect(res.started).toEqual([]);
    // The FAILED row is the last run, so the derived next slot moved on.
    expect((await getMirror(ctxFor(db, hub))).mirror?.nextRunAt).toBe('2026-09-01T06:00:00.000Z');
    await runDueMirrors({ db: db as never, hub: hub as never, auth: {} as never }, new Date('2026-09-01T05:40:00Z'));
    const runs = db.offsiteMirrorRun.rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('FAILED');
    expect(runs[0]!.error).toMatch(/object storage is off/);
  });

  test('skips orgs without a connected manager (no advance) and paused mirrors', async () => {
    await seedTarget(db);
    const hub = fakeHub({ manager: undefined });
    await saveMirror(ctxFor(db, hub), { targetId: 't1', allBuckets: true });
    await runDueMirrors({ db: db as never, hub: hub as never, auth: {} as never });
    expect(db.offsiteMirrorRun.rows).toHaveLength(0);

    const hub2 = fakeHub({ manager: 'n1' });
    await saveMirror(ctxFor(db, hub2), { targetId: 't1', allBuckets: true, enabled: false });
    await runDueMirrors({ db: db as never, hub: hub2 as never, auth: {} as never });
    expect(db.offsiteMirrorRun.rows).toHaveLength(0);
  });

  test('a not-yet-due mirror does nothing', async () => {
    await seedTarget(db);
    const hub = fakeHub({ manager: 'n1' });
    await saveMirror(ctxFor(db, hub), { targetId: 't1', allBuckets: true });
    // Last run at 06:00 → next hourly slot is 07:00.
    await db.offsiteMirrorRun.create({
      data: {
        orgId: ORG,
        mirrorId: mirrorRow().id,
        direction: 'mirror',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-09-01T06:00:00Z'),
        finishedAt: new Date('2026-09-01T06:02:00Z'),
      },
    });
    await runDueMirrors({ db: db as never, hub: hub as never, auth: {} as never }, new Date('2026-09-01T06:30:00Z'));
    expect(db.offsiteMirrorRun.rows).toHaveLength(1);
    expect(hub.calls).toHaveLength(0);
  });
});

describe('config', () => {
  test('refuses an in-cluster (Garage) destination as "off-site"', async () => {
    seedKvRows(swarmHub(db), ORG, 'bkp-target', [
      {
        id: 'native',
        name: 'swarmy-object-storage',
        kind: 'S3',
        endpoint: 'http://swarmy-garage:3900',
        bucket: 'swarmy-backups',
        credentialRef: encryptSecret('k'),
        secretKeyRef: encryptSecret('s'),
        resticPasswordRef: encryptSecret('pw'),
        enabled: true,
      },
    ]);
    await expect(
      saveMirror(ctxFor(db, fakeHub()), { targetId: 'native', allBuckets: true }),
    ).rejects.toThrow(/not off-site/);
  });

  test('defaults to copy mode, hourly, first run on the next tick', async () => {
    await seedTarget(db);
    const view = await saveMirror(ctxFor(db, fakeHub()), { targetId: 't1', allBuckets: true });
    expect(view.mirror?.mode).toBe('copy');
    expect(view.mirror?.everyMinutes).toBe(60);
    expect(view.mirror?.root).toBe('acme-dr/swarmy-mirror');
    // No stored nextRunAt: never run → due on the next tick.
    expect('nextRunAt' in mirrorRow()).toBe(false);
    expect(typeof view.mirror?.nextRunAt).toBe('string');
  });
});

describe('restore guard (service)', () => {
  test('an unconfirmed restore is refused, audited, and touches nothing', async () => {
    await seedTarget(db);
    await seedStore(db);
    const hub = fakeHub({ manager: 'n1' });
    const ctx = ctxFor(db, hub);
    await saveMirror(ctx, { targetId: 't1', allBuckets: true });
    const before = hub.calls.length;
    await expect(restoreFromOffsite(ctx, { confirm: 'yes please' })).rejects.toThrow(
      /type the destination name "b2-dr"/,
    );
    expect(db.offsiteMirrorRun.rows).toHaveLength(0);
    // only the read-only store overview ran — no rclone, no bucket creation
    expect(hub.calls.slice(before).some((c) => c.payload.image.startsWith('rclone/'))).toBe(false);
    expect(db.auditLog.rows.map((r) => r.action)).toContain('offsite.restore.refused');
  });

  test('a confirmed restore recreates missing buckets and copies back', async () => {
    await seedTarget(db);
    await seedStore(db);
    const hub = fakeHub({ manager: 'n1' });
    // off-site listing returns one existing + one lost bucket
    const origDispatch = hub.dispatch.bind(hub);
    hub.dispatch = async (node: string, cmd: string, payload: Call['payload']) => {
      if (payload.image.startsWith('rclone/') && payload.cmd[0]!.includes('lsf')) {
        hub.calls.push({ cmd, payload });
        return { exitCode: 0, output: '__SWARMY_MIRROR_LIST__\nswarmy-backups/\nswarmy-edge-certs/\n.swarmy-trash/\n' };
      }
      if (payload.env?.GARAGE_URL?.endsWith('/bucket') && payload.env.GARAGE_METHOD === 'POST') {
        hub.calls.push({ cmd, payload });
        return { exitCode: 0, output: `__SWARMY_STATUS__:200\n${JSON.stringify({ id: 'b2', globalAliases: ['swarmy-edge-certs'] })}` };
      }
      return origDispatch(node, cmd, payload);
    };
    const ctx = ctxFor(db, hub);
    await saveMirror(ctx, { targetId: 't1', allBuckets: true });
    const res = await restoreFromOffsite(ctx, { confirm: 'b2-dr' });
    expect(res.buckets).toEqual(['swarmy-backups', 'swarmy-edge-certs']);
    await flush();
    const created = hub.calls.filter((c) => c.payload.env?.GARAGE_URL?.endsWith('/bucket') && c.payload.env.GARAGE_METHOD === 'POST');
    expect(created).toHaveLength(1);
    const restore = hub.calls.find((c) => c.payload.image.startsWith('rclone/') && c.payload.cmd[0]!.includes('"garage:$b"') && !c.payload.cmd[0]!.includes('lsf'))!;
    expect(restore.payload.cmd[0]).toContain('rclone copy "offsite:$OFFSITE_ROOT/$b" "garage:$b"');
    expect(restore.payload.env.MIRROR_BUCKETS).toBe('swarmy-backups swarmy-edge-certs');
    const run = db.offsiteMirrorRun.rows.find((r) => r.id === res.runId)!;
    expect(run.direction).toBe('restore');
    expect(run.actorId).toBe('u1');
    expect(db.auditLog.rows.map((r) => r.action)).toContain('offsite.restore.start');
  });
});
