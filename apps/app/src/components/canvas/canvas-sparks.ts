import type { InvService } from '@swarmy/core';
import { otelServiceName } from '@/components/app-tabs/scaling/series-model';
import { shortOf } from '@/components/connections/connections-model';
import { bucketTime } from '@/components/incidents/incident-chart-model';

/** One hour in two-minute buckets: thirty points per part. */
export const SPARK_WINDOW_MIN = 60;
export const SPARK_BUCKET_S = 120;

interface SeriesLike {
  service: string;
  points: Array<{ bucket: string; calls: number }>;
}

/** The names a part's spans may carry, in match order: OTEL_SERVICE_NAME, swarm name, short name. */
function namesOf(stack: string, s: Pick<InvService, 'name' | 'env'>): string[] {
  return [...new Set([otelServiceName(s), s.name, shortOf(stack, s.name)])];
}

/** Every name to ask `observability.requestSeriesMany` for, capped at the procedure's limit. */
export function sparkNames(stack: string, services: readonly Pick<InvService, 'name' | 'env'>[]): string[] {
  return [...new Set(services.flatMap((s) => namesOf(stack, s)))].slice(0, 60);
}

/**
 * A series → calls per bucket across the window, oldest first. Before the
 * first bucket with spans is a gap (unknown); after it, a bucket without
 * spans had no calls, so it is a real zero.
 */
export function sparkValues(points: SeriesLike['points'], now: number, windowMin = SPARK_WINDOW_MIN, bucketS = SPARK_BUCKET_S): (number | null)[] {
  const step = bucketS * 1000;
  const count = Math.max(1, Math.round((windowMin * 60) / bucketS));
  const start = Math.floor(now / step) * step - (count - 1) * step;
  const out: (number | null)[] = Array.from({ length: count }, () => null);
  for (const p of points) {
    const i = Math.round((bucketTime(p.bucket) - start) / step);
    if (i >= 0 && i < count) out[i] = (out[i] ?? 0) + p.calls;
  }
  const first = out.findIndex((v) => v !== null);
  return first < 0 ? out : out.map((v, i) => (i >= first && v === null ? 0 : v));
}

/** Per part (keyed by short name): its sparkline values, from the first series that matches one of its names. */
export function serviceSparks(stack: string, services: readonly InvService[], series: readonly SeriesLike[], now: number): Map<string, (number | null)[]> {
  const byName = new Map(series.map((s) => [s.service, s.points]));
  const out = new Map<string, (number | null)[]>();
  for (const s of services) {
    const points = namesOf(stack, s).map((n) => byName.get(n)).find((p) => p && p.length > 0);
    if (points) out.set(shortOf(stack, s.name), sparkValues(points, now));
  }
  return out;
}
