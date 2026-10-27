import { decodeLatency, type TrafficSeriesRow } from '@swarmy/core';
import type { TelemetryDB } from '@swarmy/db';

/**
 * traffic.series — one rollup table's rows for a span: summed counts per
 * bucket, the buckets an edge reported in (coverage rows, `host = ''`), and
 * the duration buckets for p50/p95 (an edge-wide series reads the coverage
 * rows' whole-edge histograms; an app or address reads its own host rows).
 *
 * The 5-minute (`EdgeTrafficRollup`) and hourly (`EdgeTrafficHourly`) tables
 * have the same columns, so one reader serves both.
 */

type RollupTable = TelemetryDB['edgeTrafficRollup'];

export function rollupTable(tdb: TelemetryDB, hourly: boolean): RollupTable {
  // Same columns and unique key; only the bucket width differs.
  return hourly ? (tdb.edgeTrafficHourly as unknown as RollupTable) : tdb.edgeTrafficRollup;
}

export interface RollupFilter {
  orgId: string;
  /** Edge narrowing (region / nodeId). */
  edgeWhere: { region?: string; nodeId?: string };
  /** Host narrowing (one host or every non-coverage row; optional app). */
  hostWhere: { host: string | { not: string }; app?: string | null };
  /** True when an app or a host narrows the series (latency from host rows). */
  perHost: boolean;
}

export interface RollupRead {
  rows: TrafficSeriesRow[];
  /** Bucket starts an edge (in the filter) reported in. */
  coveredAt: number[];
}

export async function readRollups(table: RollupTable, f: RollupFilter, from: number): Promise<RollupRead> {
  const since = { orgId: f.orgId, bucketStart: { gte: new Date(from) } };
  const [dataRows, coverRows, latencyRows] = await Promise.all([
    table
      .groupBy({
        by: ['bucketStart'],
        where: { ...since, ...f.edgeWhere, ...f.hostWhere },
        _sum: { requests: true, errors5xx: true, status403: true, status429: true },
      })
      .catch(() => []),
    table.groupBy({ by: ['bucketStart'], where: { ...since, ...f.edgeWhere, host: '' } }).catch(() => []),
    table
      .findMany({
        where: { ...since, ...f.edgeWhere, ...(f.perHost ? f.hostWhere : { host: '' }), durationBuckets: { not: null } },
        select: { bucketStart: true, durationBuckets: true },
      })
      .catch(() => []),
  ]);

  const rows: TrafficSeriesRow[] = dataRows.map((r) => ({
    t: r.bucketStart.getTime(),
    nodeId: '',
    host: '*',
    requests: r._sum.requests ?? 0,
    errors5xx: r._sum.errors5xx ?? 0,
    ...(r._sum.status403 !== null ? { status403: r._sum.status403 } : {}),
    ...(r._sum.status429 !== null ? { status429: r._sum.status429 } : {}),
  }));
  for (const r of latencyRows) {
    const latency = decodeLatency(r.durationBuckets);
    if (latency) rows.push({ t: r.bucketStart.getTime(), nodeId: '', host: '', requests: 0, errors5xx: 0, latency });
  }
  return { rows, coveredAt: coverRows.map((r) => r.bucketStart.getTime()) };
}
