import {
  TRAFFIC_HOURLY_RETENTION_MS,
  TRAFFIC_HOUR_MS,
  decodeLatency,
  encodeLatency,
  firstHourToFold,
  foldTrafficHours,
  hoursToFold,
  type StoredTrafficRollup,
} from '@swarmy/core';
import type { TelemetryDB } from '@swarmy/db';

/**
 * Per-edge request counting (Q4) — the hourly tier's write layer. The
 * edge-traffic worker calls {@link advanceTrafficHours} each tick after the
 * 5-minute flush: every completed hour whose 5-minute rows are all written
 * is refolded FROM THOSE ROWS (never from the ring) and upserted, so a
 * restart mid-hour, or folding an hour twice, never doubles it. The fold
 * itself is pure (`foldTrafficHours`, @swarmy/core).
 */

type RollupRow = Awaited<ReturnType<TelemetryDB['edgeTrafficRollup']['findMany']>>[number];

function toStored(r: RollupRow): StoredTrafficRollup {
  const latency = decodeLatency(r.durationBuckets);
  return {
    bucketStart: r.bucketStart.getTime(),
    nodeId: r.nodeId,
    host: r.host,
    region: r.region,
    app: r.app,
    requests: r.requests,
    errors5xx: r.errors5xx,
    ...(r.status403 !== null ? { status403: r.status403 } : {}),
    ...(r.status429 !== null ? { status429: r.status429 } : {}),
    ...(latency ? { latency } : {}),
  };
}

/** Fold one org's 5-minute rows for `hours` (contiguous hour starts) into hourly rows. Returns rows written. */
export async function foldTrafficHoursFor(tdb: TelemetryDB, orgId: string, hours: readonly number[]): Promise<number> {
  if (hours.length === 0) return 0;
  const from = new Date(Math.min(...hours));
  const to = new Date(Math.max(...hours) + TRAFFIC_HOUR_MS);
  const rows = await tdb.edgeTrafficRollup.findMany({ where: { orgId, bucketStart: { gte: from, lt: to } } });
  const folded = foldTrafficHours(rows.map(toStored));
  if (folded.length === 0) return 0;
  await tdb.$transaction(
    folded.map((r) => {
      const bucketStart = new Date(r.bucketStart);
      const data = {
        region: r.region,
        app: r.app,
        requests: r.requests,
        errors5xx: r.errors5xx,
        status403: r.status403 ?? null,
        status429: r.status429 ?? null,
        durationBuckets: r.latency ? encodeLatency(r.latency) : null,
      };
      return tdb.edgeTrafficHourly.upsert({
        where: { orgId_nodeId_host_bucketStart: { orgId, nodeId: r.nodeId, host: r.host, bucketStart } },
        create: { orgId, nodeId: r.nodeId, host: r.host, bucketStart, ...data },
        update: data,
      });
    }),
  );
  return folded.length;
}

/** Where a (re)started worker resumes an org's fold (see `firstHourToFold`). */
export async function trafficFoldStart(tdb: TelemetryDB, orgId: string, boot: number): Promise<number> {
  const [newest, oldest] = await Promise.all([
    tdb.edgeTrafficHourly.findFirst({ where: { orgId }, orderBy: { bucketStart: 'desc' }, select: { bucketStart: true } }),
    tdb.edgeTrafficRollup.findFirst({ where: { orgId }, orderBy: { bucketStart: 'asc' }, select: { bucketStart: true } }),
  ]);
  return firstHourToFold({
    newestFolded: newest?.bucketStart.getTime() ?? null,
    oldestRollup: oldest?.bucketStart.getTime() ?? null,
    boot,
  });
}

/**
 * Fold an org's ready hours: from `mark` (or where the table says to resume)
 * up to `flushedTo`, the 5-minute watermark. Returns the next mark; on a
 * telemetry.db error it throws and the caller keeps the old mark.
 */
export async function advanceTrafficHours(
  tdb: TelemetryDB,
  orgId: string,
  args: { mark?: number | undefined; flushedTo: number; boot: number },
): Promise<number> {
  const mark = args.mark ?? (await trafficFoldStart(tdb, orgId, args.boot));
  const hours = hoursToFold(mark, args.flushedTo);
  if (hours.length === 0) return mark;
  await foldTrafficHoursFor(tdb, orgId, hours);
  return hours[hours.length - 1]! + TRAFFIC_HOUR_MS;
}

/** Drop hourly rollups older than 35 days (all orgs). */
export async function pruneTrafficHours(tdb: TelemetryDB, now = Date.now()): Promise<number> {
  const res = await tdb.edgeTrafficHourly.deleteMany({
    where: { bucketStart: { lt: new Date(now - TRAFFIC_HOURLY_RETENTION_MS) } },
  });
  return res.count;
}
