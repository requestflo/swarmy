/**
 * Slow queries over 24 h (studio insights) — pure. pg_stat_statements is
 * cumulative since the last reset, so the controller snapshots it every
 * {@link SLOW_SNAPSHOT_MS} and keeps per-statement DELTAS; the 24 h view sums
 * them. Postgres keeps each statement's count, total, mean, standard
 * deviation, min and max, never per-call times, so there is NO percentile
 * here: the view shows the mean and the spread over the window (exact, from
 * the sum-of-squares deltas: calls·(σ² + μ²) per snapshot) and the slowest
 * single call since the statistics were reset (`max_exec_time`, cumulative).
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
  return (
    'SELECT queryid::text AS queryid, sum(calls)::bigint AS calls, round(sum(total_exec_time)::numeric, 3) AS total_ms, sum(rows)::bigint AS rows, ' +
    `left(min(query), ${SLOW_QUERY_TEXT_MAX}) AS query, ` +
    'round(sum(calls * (power(stddev_exec_time, 2) + power(mean_exec_time, 2)))::numeric, 3) AS sumsq_ms2, round(max(max_exec_time)::numeric, 3) AS max_ms ' +
    'FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND queryid IS NOT NULL ' +
    `GROUP BY queryid ORDER BY sum(total_exec_time) DESC LIMIT ${limit}`
  );
}

export interface StatementTotals {
  queryId: string;
  calls: number;
  totalMs: number;
  rows: number;
  query: string;
  /** Σ call time² (ms²) = calls·(stddev² + mean²). Null = not read. */
  sumSqMs2?: number | null;
  /** The slowest single call since the statistics were reset (cumulative). */
  maxMs?: number | null;
}

export type StatementDelta = StatementTotals;

/** Snapshot result rows (`columns` + `rows`) → totals; malformed rows are skipped. */
export function parseSnapshotRows(r: { columns: string[]; rows: unknown[][] }): StatementTotals[] {
  const at = (name: string) => r.columns.indexOf(name);
  const [q, c, t, n, s, sq, mx] = [at('queryid'), at('calls'), at('total_ms'), at('rows'), at('query'), at('sumsq_ms2'), at('max_ms')];
  const opt = (row: unknown[], i: number): number | null => (i < 0 || row[i] == null || row[i] === '' || !Number.isFinite(Number(row[i])) ? null : Number(row[i]));
  const out: StatementTotals[] = [];
  for (const row of r.rows) {
    const calls = Number(row[c]);
    const totalMs = Number(row[t]);
    const id = row[q];
    if (id == null || !Number.isFinite(calls) || !Number.isFinite(totalMs)) continue;
    out.push({ queryId: String(id), calls, totalMs, rows: Number(row[n]) || 0, query: String(row[s] ?? ''), sumSqMs2: opt(row, sq), maxMs: opt(row, mx) });
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * This snapshot minus the previous one. No previous snapshot ⇒ a baseline
 * only (nothing stored). A statement whose counters went DOWN was reset
 * (server restart, pg_stat_statements_reset) ⇒ its whole current total is the
 * delta. A statement missing from the previous snapshot counts only when that
 * snapshot was complete (under the limit), else it may just have re-entered
 * the top N with old history. Zero-call deltas are dropped; the slowest
 * `keep` remain. The sum of squares subtracts like the totals (null when
 * either side lacks it); the max is carried as it stands (it is cumulative).
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
    else {
      const sumSq = r.sumSqMs2 != null && p.sumSqMs2 != null ? Math.max(0, r.sumSqMs2 - p.sumSqMs2) : null;
      d = { queryId: r.queryId, calls: r.calls - p.calls, totalMs: r.totalMs - p.totalMs, rows: Math.max(0, r.rows - p.rows), query: r.query, sumSqMs2: sumSq, maxMs: r.maxMs };
    }
    if (d && d.calls > 0) out.push({ ...d, totalMs: round3(d.totalMs), sumSqMs2: d.sumSqMs2 == null ? null : round3(d.sumSqMs2), maxMs: d.maxMs ?? null });
  }
  return out.sort((a, b) => b.totalMs - a.totalMs).slice(0, opts.keep ?? SLOW_SNAPSHOT_KEEP);
}

export interface SlowSample {
  queryId: string;
  calls: number;
  totalMs: number;
  rows: number;
  sumSqMs2?: number | null;
  maxMs?: number | null;
}

export interface SlowQueryRow {
  queryId: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  /** Standard deviation of call time over the window; null while any snapshot in it lacks the sum of squares. */
  stddevMs: number | null;
  /** The slowest single call since the statistics were reset (not only this window). */
  maxMs: number | null;
  rows: number;
  /** Snapshots the statement ran in. */
  samples: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Population standard deviation from n, Σx and Σx² (null without Σx²). */
export function spreadMs(calls: number, totalMs: number, sumSqMs2: number | null): number | null {
  if (sumSqMs2 === null || calls <= 0) return null;
  const mean = totalMs / calls;
  return Math.sqrt(Math.max(0, sumSqMs2 / calls - mean * mean));
}

/** 24 h of deltas (oldest first) → one row per statement, slowest total first. */
export function aggregateSlowQueries(samples: readonly SlowSample[], texts: ReadonlyMap<string, string>, limit = 25): SlowQueryRow[] {
  const by = new Map<string, SlowSample[]>();
  for (const s of samples) by.set(s.queryId, [...(by.get(s.queryId) ?? []), s]);
  const rows: SlowQueryRow[] = [];
  for (const [queryId, ss] of by) {
    const calls = ss.reduce((n, s) => n + s.calls, 0);
    const totalMs = ss.reduce((n, s) => n + s.totalMs, 0);
    if (calls === 0) continue;
    const sumSq = ss.every((s) => s.sumSqMs2 != null) ? ss.reduce((n, s) => n + (s.sumSqMs2 ?? 0), 0) : null;
    const sd = spreadMs(calls, totalMs, sumSq);
    const max = [...ss].reverse().find((s) => s.maxMs != null)?.maxMs ?? null;
    rows.push({
      queryId,
      query: texts.get(queryId) ?? '',
      calls,
      totalMs: round2(totalMs),
      meanMs: round2(totalMs / calls),
      stddevMs: sd === null ? null : round2(sd),
      maxMs: max === null ? null : round2(max),
      rows: ss.reduce((n, s) => n + s.rows, 0),
      samples: ss.length,
    });
  }
  return rows.sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
}
