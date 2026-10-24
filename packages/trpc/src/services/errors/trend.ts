/**
 * An issue's last 24 hours as hourly event counts — the one bucketing both
 * `errors.issues` (the list's bars) and `errors.issue` (the detail chart) use,
 * so the two can never disagree about the same hour.
 */
import type { OrgClickhouse } from '../observability.service';
import { buildIssueTrendQuery, type IssueTrendRow } from './query';

const HOUR = 3_600_000;
export const TREND_HOURS = 24;

/** 24 hourly buckets for `fingerprint`, oldest first, the last one is this hour. */
export function trendFor(rows: IssueTrendRow[], fingerprint: string, now = Date.now()): number[] {
  const start = Math.floor(now / HOUR) * HOUR - (TREND_HOURS - 1) * HOUR;
  const out = new Array<number>(TREND_HOURS).fill(0);
  for (const r of rows) {
    if (r.fingerprint !== fingerprint) continue;
    const t = Date.parse(`${r.bucket.replace(' ', 'T')}Z`);
    const i = Math.round((t - start) / HOUR);
    if (i >= 0 && i < TREND_HOURS) out[i] = Number(r.c) || 0;
  }
  return out;
}

/**
 * Read the trend rows for some issues (one org-scoped query) and hand back a
 * lookup. A store that doesn't answer reads as no events — the issue rows
 * themselves already decided reachability.
 */
export async function loadTrends(
  ch: Pick<OrgClickhouse, 'database' | 'query'>,
  orgId: string,
  projectId: number,
  fingerprints: string[],
  now = Date.now(),
): Promise<(fingerprint: string) => number[]> {
  const rows = fingerprints.length
    ? ((await ch.query<IssueTrendRow>(buildIssueTrendQuery(ch.database, orgId, projectId, fingerprints))) ?? [])
    : [];
  return (fp) => trendFor(rows, fp, now);
}
