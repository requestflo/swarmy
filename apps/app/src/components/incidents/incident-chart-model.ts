import type { ReleaseView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { durationWords } from './incident-guess';
import type { IncidentMetric } from './incident-scope';
import { versionOf } from './incident-words';

export interface RequestBucket {
  bucket: string;
  calls: number;
  errors: number;
  p95_ms: number;
}

export interface ChartPoint {
  t: number;
  v: number;
}

/** ClickHouse's "2026-09-26 18:05:00" (UTC) → ms. */
export function bucketTime(bucket: string): number {
  return Date.parse(`${bucket.replace(' ', 'T')}Z`);
}

/** Error share (%) or p95 (ms) per bucket; a bucket with no calls is a gap, never a zero. */
export function seriesFor(metric: IncidentMetric, rows: RequestBucket[]): ChartPoint[] {
  return rows
    .filter((r) => r.calls > 0)
    .map((r) => ({ t: bucketTime(r.bucket), v: metric === 'errors' ? (r.errors / r.calls) * 100 : r.p95_ms }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
}

export function formatValue(metric: IncidentMetric, v: number): string {
  if (metric === 'latency') return durationWords(v);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

/** Health thresholds mirror the service map's (5% errors, 1.5 s p95). */
export function valueTone(metric: IncidentMetric, v: number): Tone {
  if (metric === 'errors') return v >= 5 ? 'bad' : v >= 2 ? 'warn' : 'ok';
  return v >= 1500 ? 'bad' : v >= 800 ? 'warn' : 'ok';
}

export const METRIC_TITLE: Record<IncidentMetric, string> = {
  errors: 'Requests that failed',
  latency: 'Slowest 5% of requests',
};

const hhmm = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A dotted marker per release in the window: "18:05 deploy 1.9.0". */
export function releaseMarkers(releases: ReleaseView[], from: number, to: number): Array<{ t: number; label: string }> {
  return releases
    .map((r) => ({ t: Date.parse(r.createdAt), v: versionOf(r.images) }))
    .filter((r) => r.t >= from && r.t <= to)
    .sort((a, b) => a.t - b.t)
    .map((r) => ({ t: r.t, label: `${hhmm(r.t)} deploy${r.v ? ` ${r.v}` : ''}` }));
}

/** An SVG path over a 0..w × 0..h box (y grows down), scaled to [0, max]. */
export function linePath(points: ChartPoint[], from: number, to: number, max: number, w: number, h: number): string {
  const span = Math.max(1, to - from);
  return points
    .map((p, i) => `${i ? 'L' : 'M'}${(((p.t - from) / span) * w).toFixed(1)} ${(h - (p.v / (max || 1)) * h).toFixed(1)}`)
    .join(' ');
}
