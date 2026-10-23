import type { NodeStatsHistoryServer } from '@swarmy/core';
import { DISK_HOT_PCT } from './use-fleet';

/** One sparkline row: what it measures, its 24 h of 5-minute peaks, the highest one. */
export interface HistoryRow {
  key: 'cpu' | 'mem' | 'disk';
  label: string;
  values: Array<number | null>;
  /** The highest 5-minute peak in the window (a row exists only with a reading). */
  peak: number;
  /** The peak reached the level where the server needs you. */
  hot: boolean;
}

const ROWS = [
  { key: 'cpu', label: 'CPU', hot: 90 },
  { key: 'mem', label: 'Memory', hot: 90 },
  { key: 'disk', label: 'Disk', hot: DISK_HOT_PCT },
] as const;

/** CPU, memory and disk rows for one server; a metric with no reading at all is left out. */
export function historyRows(s: NodeStatsHistoryServer): HistoryRow[] {
  return ROWS.flatMap((r) => {
    const values = s[r.key];
    const known = values.filter((v): v is number => v !== null);
    if (known.length === 0) return [];
    const peak = Math.max(...known);
    return [{ key: r.key, label: r.label, values, peak, hot: peak >= r.hot }];
  });
}

/**
 * An SVG path for % values on a fixed 0–100 scale (so a quiet 3% CPU reads
 * flat, not as a mountain range). A null breaks the line: a gap, never a zero.
 */
export function pctPath(values: Array<number | null>, w: number, h: number): string {
  if (values.length === 0) return '';
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (v: number): number => h - 1 - (Math.max(0, Math.min(100, v)) / 100) * (h - 2);
  const parts: string[] = [];
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    parts.push(`${pen ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`);
    pen = true;
  });
  return parts.join(' ');
}
