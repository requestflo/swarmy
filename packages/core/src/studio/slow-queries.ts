/**
 * Slow queries over 24 h (studio insights) — pure. pg_stat_statements is
 * cumulative since the last reset, so the controller snapshots it every
 * {@link SLOW_SNAPSHOT_MS} and keeps per-statement DELTAS; the 24 h view sums
 * them. p95 is ESTIMATED: Postgres keeps no per-call latencies, so it is the
 * calls-weighted 95th percentile of each snapshot's mean (one slow call inside
 * a busy 5 minutes is averaged away). The view says so.
 */

export const SLOW_SNAPSHOT_MS = 5 * 60_000;
/** Statements read per snapshot (by cumulative total time). */
export const SLOW_SNAPSHOT_LIMIT = 200;
/** Deltas kept per snapshot (by total time in the interval). */
export const SLOW_SNAPSHOT_KEEP = 50;
export const SLOW_QUERY_TEXT_MAX = 1000;

/**
 * One bounded read: the current database's statements aggregated by queryid
 * (one queryid can have a row per role), slowest first. PG13+ column names
 * (managed Postgres is 17).
 */
export function pgSlowSnapshotSql(limit = SLOW_SNAPSHOT_LIMIT): string {
  return `SELECT queryid::text AS queryid, sum(calls)::bigint AS calls, round(sum(total_exec_time)::numeric, 3) AS total_ms, sum(rows)::bigint AS rows, left(min(query), ${SLOW_QUERY_TEXT_MAX}) AS query FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND queryid IS NOT NULL GROUP BY queryid ORDER BY sum(total_exec_time) DESC LIMIT ${limit}`;
}

export interface StatementTotals {
  queryId: string;
  calls: number;
  totalMs: number;
  rows: number;
  query: string;
}

export type StatementDelta = StatementTotals;

/** Snapshot result rows (`columns` + `rows`) → totals; malformed rows are skipped. */
export function parseSnapshotRows(r: { columns: string[]; rows: unknown[][] }): StatementTotals[] {
  const at = (name: string) => r.columns.indexOf(name);
  const [q, c, t, n, s] = [at('queryid'), at('calls'), at('total_ms'), at('rows'), at('query')];
  const out: StatementTotals[] = [];
  for (const row of r.rows) {
    const calls = Number(row[c]);
    const totalMs = Number(row[t]);
    const id = row[q];
    if (id == null || !Number.isFinite(calls) || !Number.isFinite(totalMs)) continue;
    out.push({ queryId: String(id), calls, totalMs, rows: Number(row[n]) || 0, query: String(row[s] ?? '') });
  }
  return out;
}

/**
 * This snapshot minus the previous one. No previous snapshot ⇒ a baseline
 * only (nothing stored). A statement whose counters went DOWN was reset
 * (server restart, pg_stat_statements_reset) ⇒ its whole current total is the
 * delta. A statement missing from the previous snapshot counts only when that
 * snapshot was complete (under the limit), else it may just have re-entered
 * the top N with old history. Zero-call deltas are dropped; the slowest
 * `keep` remain.
 */
export function snapshotDeltas(
  prev: ReadonlyMap<string, StatementTotals> | null,
  rows: readonly StatementTotals[],
  opts: { limit?: number; keep?: number } = {},
): StatementDelta[] {
  if (!prev) return [];
  const prevComplete = prev.size < (opts.limit ?? SLOW_SNAPSHOT_LIMIT);
  const out: StatementDelta[] = [];
  for (const r of rows) {
    const p = prev.get(r.queryId);
    let d: StatementDelta | null;
    if (!p) d = prevComplete ? { ...r } : null;
    else if (r.calls < p.calls || r.totalMs < p.totalMs) d = { ...r };
    else d = { queryId: r.queryId, calls: r.calls - p.calls, totalMs: r.totalMs - p.totalMs, rows: Math.max(0, r.rows - p.rows), query: r.query };
    if (d && d.calls > 0) out.push({ ...d, totalMs: Math.round(d.totalMs * 1000) / 1000 });
  }
  return out.sort((a, b) => b.totalMs - a.totalMs).slice(0, opts.keep ?? SLOW_SNAPSHOT_KEEP);
}

/** Calls-weighted percentile (p in 0..1) of `value`. */
export function weightedPercentile(points: ReadonlyArray<{ value: number; weight: number }>, p: number): number | null {
  const pts = points.filter((x) => x.weight > 0 && Number.isFinite(x.value)).sort((a, b) => a.value - b.value);
  const total = pts.reduce((n, x) => n + x.weight, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const x of pts) {
    seen += x.weight;
    if (seen >= p * total) return x.value;
  }
  return pts[pts.length - 1]!.value;
}

export interface SlowSample { queryId: string; calls: number; totalMs: number; rows: number }

export interface SlowQueryRow {
  queryId: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  /** Estimated from the per-snapshot means (see the module note). */
  p95Ms: number | null;
  rows: number;
  /** Snapshots the statement ran in. */
  samples: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 24 h of deltas → one row per statement, slowest total first. */
export function aggregateSlowQueries(samples: readonly SlowSample[], texts: ReadonlyMap<string, string>, limit = 25): SlowQueryRow[] {
  const by = new Map<string, SlowSample[]>();
  for (const s of samples) by.set(s.queryId, [...(by.get(s.queryId) ?? []), s]);
  const rows: SlowQueryRow[] = [];
  for (const [queryId, ss] of by) {
    const calls = ss.reduce((n, s) => n + s.calls, 0);
    const totalMs = ss.reduce((n, s) => n + s.totalMs, 0);
    if (calls === 0) continue;
    const p95 = weightedPercentile(ss.map((s) => ({ value: s.totalMs / s.calls, weight: s.calls })), 0.95);
    rows.push({
      queryId,
      query: texts.get(queryId) ?? '',
      calls,
      totalMs: round2(totalMs),
      meanMs: round2(totalMs / calls),
      p95Ms: p95 === null ? null : round2(p95),
      rows: ss.reduce((n, s) => n + s.rows, 0),
      samples: ss.length,
    });
  }
  return rows.sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
}
