import { DATA_HISTORY_RETENTION_DAYS, type BucketsOverview } from '@swarmy/core';
import type { TelemetryDB } from '@swarmy/db';
import { telemetryOf, type OrgContext } from '../context';
import { overview } from './buckets.service';
import {
  BucketGate,
  foldQueueTick,
  queueTickOf,
  sampleBucketStart,
  workersByQueue,
  type CacheCounters,
  type QueueBucket,
} from './data-history-sample';
import type { SampledCluster } from './queue-studio.service';
import { listQueues } from './queues.service';

/**
 * Managed data history: the writes. The reconcile workers call these with
 * numbers they already read each tick (cache INFO, the BullMQ sampler's
 * overview, Garage bucket info), and each resource gets at most one
 * telemetry.db row per 5-minute bucket. Caches and buckets keep the first
 * reading of a bucket (gate + `update: {}`); a queue's bucket is written
 * once, after it ends, with its peaks and finished-job sums. Every write is
 * an upsert on the unique key, so a restart never doubles a bucket.
 */

const cacheGate = new BucketGate();
const bucketGate = new BucketGate();
interface QueueId {
  stack: string;
  cluster: string;
  prefix: string;
  queue: string;
}
const openQueues = new Map<string, { id: QueueId; acc: QueueBucket }>();

/** A cache primary's counters, once per bucket. Resolves true when it wrote. */
export async function recordCacheHistory(
  ctx: OrgContext,
  c: { stack: string; cluster: string } & CacheCounters,
  now = Date.now(),
): Promise<boolean> {
  const orgId = ctx.activeOrgId;
  const key = `${orgId}|${c.stack}|${c.cluster}`;
  const bucket = cacheGate.due(key, now);
  if (bucket === null) return false;
  const where = { orgId, stack: c.stack, cluster: c.cluster, bucketStart: new Date(bucket) };
  const data = { hits: BigInt(c.hits), misses: BigInt(c.misses), opsPerSec: c.opsPerSec, usedMemoryBytes: BigInt(c.usedMemoryBytes) };
  await telemetryOf(ctx).cacheStatSample.upsert({
    where: { orgId_stack_cluster_bucketStart: where },
    create: { ...where, ...data },
    update: {},
  });
  cacheGate.mark(key, bucket);
  return true;
}

/**
 * Fold one BullMQ sampler tick (the queue-reconcile worker's) into each
 * queue's open bucket, and write the buckets that ended. A queue that went
 * quiet still gets its last bucket written. Resolves the rows written.
 */
export async function recordQueueHistory(ctx: OrgContext, sampled: SampledCluster[], now = Date.now()): Promise<number> {
  const orgId = ctx.activeOrgId;
  const workers = workersByQueue(listQueues(ctx));
  const closed: Array<{ id: QueueId; acc: QueueBucket }> = [];
  const seen = new Set<string>();
  for (const c of sampled) {
    for (const q of c.queues) {
      const id = { stack: c.stack, cluster: c.cluster, prefix: c.prefix, queue: q.name };
      const key = `${orgId}|${id.stack}|${id.cluster}|${id.prefix}|${id.queue}`;
      seen.add(key);
      const tick = queueTickOf(q, c.rates[q.name] ?? null, workers.get(`${c.stack}/${c.cluster}/${q.name}`) ?? null);
      const r = foldQueueTick(openQueues.get(key)?.acc, now, tick);
      openQueues.set(key, { id, acc: r.open });
      if (r.closed) closed.push({ id, acc: r.closed });
    }
  }
  const current = sampleBucketStart(now);
  for (const [key, o] of openQueues) {
    if (key.startsWith(`${orgId}|`) && !seen.has(key) && o.acc.bucket < current) {
      closed.push(o);
      openQueues.delete(key);
    }
  }
  if (closed.length === 0) return 0;
  const tdb = telemetryOf(ctx);
  await tdb.$transaction(
    closed.map(({ id, acc }) => {
      const where = { orgId, ...id, bucketStart: new Date(acc.bucket) };
      const data = { waiting: acc.waiting, active: acc.active, completed: acc.completed, failed: acc.failed, workers: acc.workers };
      return tdb.queueStatSample.upsert({
        where: { orgId_stack_cluster_prefix_queue_bucketStart: where },
        create: { ...where, ...data },
        update: data,
      });
    }),
  );
  return closed.length;
}

/**
 * Every bucket's size, once per 5-minute bucket per org (`read` is the
 * Garage overview; tests pass their own). Marked before the read, so a store
 * that can't be reached is asked once a bucket, not every tick. Resolves the
 * rows written.
 */
export async function recordBucketHistory(
  ctx: OrgContext,
  now = Date.now(),
  read: (ctx: OrgContext) => Promise<BucketsOverview> = overview,
): Promise<number> {
  const orgId = ctx.activeOrgId;
  const bucket = bucketGate.due(orgId, now);
  if (bucket === null) return 0;
  bucketGate.mark(orgId, bucket);
  const ov = await read(ctx);
  const rows = ov.state === 'ready' ? ov.buckets.filter((b) => b.id) : [];
  if (rows.length === 0) return 0;
  const tdb = telemetryOf(ctx);
  const bucketStart = new Date(bucket);
  await tdb.$transaction(
    rows.map((b) =>
      tdb.bucketStatSample.upsert({
        where: { orgId_bucketId_bucketStart: { orgId, bucketId: b.id, bucketStart } },
        create: { orgId, bucketId: b.id, bucketStart, bytes: BigInt(Math.max(0, Math.floor(b.usageBytes))), objects: b.objects },
        update: {},
      }),
    ),
  );
  return rows.length;
}

/** Drop history older than 7 days (all orgs). Run by the hourly retention worker. */
export async function pruneDataHistory(tdb: TelemetryDB, now = Date.now()): Promise<number> {
  const where = { bucketStart: { lt: new Date(now - DATA_HISTORY_RETENTION_DAYS * 86_400_000) } };
  const [c, q, b] = await Promise.all([
    tdb.cacheStatSample.deleteMany({ where }),
    tdb.queueStatSample.deleteMany({ where }),
    tdb.bucketStatSample.deleteMany({ where }),
  ]);
  return c.count + q.count + b.count;
}

/** Tests: forget the gates and the open queue buckets. */
export function resetDataHistorySampler(): void {
  cacheGate.clear();
  bucketGate.clear();
  openQueues.clear();
}
