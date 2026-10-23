import type { InvService } from '@swarmy/core';
import { bucketTime } from '@/components/incidents/incident-chart-model';
import type { CallBucket } from './sleep-sim';

/**
 * Where yesterday's requests come from: `observability.requestSeries`
 * (entry spans per 5-minute bucket, filtered by the span's ServiceName).
 * PURE — unit-tested in sleep-sim.test.ts.
 */

export const SERIES_BUCKET_SEC = 300;

/** Yesterday 00:00 → today 00:00 in the viewer's time zone, and the query window that covers it. */
export function yesterdayWindow(now: number): { from: number; to: number; windowMinutes: number } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const to = today.getTime();
  const y = new Date(to);
  y.setDate(y.getDate() - 1);
  const from = y.getTime();
  return { from, to, windowMinutes: Math.ceil((now - from) / 60_000) + 5 };
}

/**
 * The name its spans carry: the service's own `OTEL_SERVICE_NAME` (swarmy
 * injects the service name and never overwrites one the app set).
 */
export function otelServiceName(inv: Pick<InvService, 'name' | 'env'>): string {
  const kv = inv.env.find((e) => e.startsWith('OTEL_SERVICE_NAME='));
  const v = kv?.slice('OTEL_SERVICE_NAME='.length).trim();
  return v || inv.name;
}

/** requestSeries rows → call buckets (ClickHouse buckets are UTC strings). */
export function toCallBuckets(rows: Array<{ bucket: string; calls: number }>): CallBucket[] {
  return rows.map((r) => ({ t: bucketTime(r.bucket), calls: r.calls })).filter((b) => Number.isFinite(b.t));
}
