import type { DbBackupSnapshotView, DbPitrWindowView } from '@swarmy/core';
import { WEEK_MS } from './time-travel-model';

/**
 * A database's size over the week, pure, from what its backups recorded.
 * Two measures, never mixed on one line:
 *  - `data`: a wal-g base backup's data size (wal-g's `uncompressed_size`),
 *    the data directory as it was copied: the database's real size then.
 *  - `dump`: a logical save's size. A dump is smaller than the database
 *    (no indexes, and `pg_dump` compresses), but it grows and shrinks with
 *    it. Only saves of one engine count, so a `pg_dumpall` safety copy
 *    never reads as a jump.
 */

export type SizeMeasure = 'data' | 'dump';

export interface SizePoint {
  at: number;
  /** 0 (7 days ago) … 1 (now), clamped. */
  pos: number;
  bytes: number;
}

export interface SizeSeries {
  cluster: string;
  measure: SizeMeasure;
  /** Oldest first; may start before the week (the value carried in at its left edge). */
  points: SizePoint[];
}

const LOGICAL = new Set(['pg_dump', 'pg_dumpall', 'snapshot-from-replica']);

export function sizeSeries(input: {
  cluster: string;
  saves?: DbBackupSnapshotView[];
  baseBackups?: DbPitrWindowView['backups'];
  now: number;
}): SizeSeries | null {
  const from = input.now - WEEK_MS;
  const point = (iso: string, bytes: string | null | undefined): SizePoint | null => {
    const at = Date.parse(iso);
    const n = Number(bytes);
    if (!Number.isFinite(at) || at > input.now || !Number.isFinite(n) || n <= 0) return null;
    return { at, pos: Math.max(0, (at - from) / WEEK_MS), bytes: n };
  };
  // Oldest first; of the points before the week only the newest stays (the value at its left edge).
  const sorted = (xs: Array<SizePoint | null>): SizePoint[] => {
    const all = xs.filter((p): p is SizePoint => p !== null).sort((a, b) => a.at - b.at);
    const carried = all.filter((p) => p.at < from).at(-1);
    return [...(carried ? [carried] : []), ...all.filter((p) => p.at >= from)];
  };

  const data = sorted((input.baseBackups ?? []).map((b) => point(b.finishTime, b.sizeBytes)));
  if (data.length) return { cluster: input.cluster, measure: 'data', points: data };
  // The schedule's own dumps: not a pre-restore safety copy, and the engine most saves used
  // (a replica dump is a `pg_dump` too: same archive, same measure).
  const kind = (e: string | null): string => (e === 'snapshot-from-replica' ? 'pg_dump' : (e ?? ''));
  const logical = (input.saves ?? []).filter((s) => s.engine && LOGICAL.has(s.engine) && s.reason !== 'pre-restore');
  const counts = new Map<string, number>();
  for (const s of logical) counts.set(kind(s.engine), (counts.get(kind(s.engine)) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return null;
  const dump = sorted(logical.filter((s) => kind(s.engine) === main).map((s) => point(s.time, s.sizeBytes)));
  return dump.length ? { cluster: input.cluster, measure: 'dump', points: dump } : null;
}

/** The size recorded at or before T (the newest such point), or null before the first. */
export function sizeAt(series: SizeSeries, t: number): SizePoint | null {
  return series.points.filter((p) => p.at <= t).at(-1) ?? null;
}

/** The lane's step line as SVG points in a 1000 × h box: flat until the next save, to the head of the week. */
export function sizePath(series: SizeSeries, h: number, pad = 6): string {
  const pts = series.points;
  if (!pts.length) return '';
  const lo = Math.min(...pts.map((p) => p.bytes));
  const hi = Math.max(...pts.map((p) => p.bytes));
  const y = (b: number): number => (hi === lo ? h / 2 : pad + (1 - (b - lo) / (hi - lo)) * (h - 2 * pad));
  const out: string[] = [];
  pts.forEach((p, i) => {
    const x = Math.round(p.pos * 1000);
    if (i > 0) out.push(`${x},${y(pts[i - 1]!.bytes).toFixed(1)}`);
    out.push(`${x},${y(p.bytes).toFixed(1)}`);
  });
  out.push(`1000,${y(pts.at(-1)!.bytes).toFixed(1)}`);
  return out.join(' ');
}
