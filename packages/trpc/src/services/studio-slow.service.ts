import { DB_EXTENSIONS_APPLIED_LABEL, STACK_LABEL, parseExtList } from '@swarmy/core';
import {
  SLOW_SNAPSHOT_MS,
  aggregateSlowQueries,
  parseSnapshotRows,
  pgSlowSnapshotSql,
  snapshotDeltas,
  type SlowQueryRow,
  type StatementTotals,
} from '@swarmy/core/studio';
import type { TelemetryDB } from '@swarmy/db';
import { telemetryOf, type OrgContext } from '../context';
import { studioSystemRead } from './studio.service';

/**
 * Slow queries over 24 h (studio insights, board 63). The pg-slow-queries
 * worker calls {@link snapshotSlowQueries} every ~5 minutes for each managed
 * Postgres with pg_stat_statements on: one bounded, audited system read
 * through the studio path, the per-statement DELTAS since the previous
 * snapshot into telemetry.db (`PgQuerySample`, texts once in `PgQueryText`).
 * `studio.slowQueries` sums the window. p95 is estimated from the per-snapshot
 * means (Postgres keeps no per-call latencies) and the view says so.
 */

export interface SlowQueryTarget { stack: string; target: string }

/** Managed Postgres clusters whose primary has pg_stat_statements applied (labels; no exec). */
export function slowQueryTargets(ctx: OrgContext): SlowQueryTarget[] {
  return ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter(
      (s) =>
        s.labels['swarmy.db.engine'] === 'postgres' &&
        s.labels['swarmy.db.role'] === 'primary' &&
        !s.labels['swarmy.db.member'] &&
        Boolean(s.labels['swarmy.db.cluster']) &&
        parseExtList(s.labels[DB_EXTENSIONS_APPLIED_LABEL]).includes('pg_stat_statements'),
    )
    .map((s) => ({ stack: s.labels[STACK_LABEL] ?? '', target: s.labels['swarmy.db.cluster']! }));
}

/**
 * One snapshot. `prev` = the previous snapshot's totals (null after a
 * controller restart: this one is then a baseline and nothing is stored).
 * Returns this snapshot's totals for the next call.
 */
export async function snapshotSlowQueries(
  ctx: OrgContext,
  t: SlowQueryTarget,
  prev: ReadonlyMap<string, StatementTotals> | null,
  now = new Date(),
): Promise<{ totals: Map<string, StatementTotals>; written: number }> {
  const r = await studioSystemRead(ctx, { ...t, statement: pgSlowSnapshotSql(), rowCap: 250 });
  const rows = parseSnapshotRows(r);
  const totals = new Map(rows.map((x) => [x.queryId, x]));
  const deltas = snapshotDeltas(prev, rows);
  if (deltas.length === 0) return { totals, written: 0 };
  const tdb = telemetryOf(ctx);
  const key = { orgId: ctx.activeOrgId, stack: t.stack, target: t.target };
  await tdb.pgQuerySample.createMany({
    data: deltas.map((d) => ({ ...key, queryId: d.queryId, calls: d.calls, totalMs: d.totalMs, rows: d.rows, ts: now })),
  });
  for (const d of deltas) {
    await tdb.pgQueryText.upsert({
      where: { orgId_stack_target_queryId: { ...key, queryId: d.queryId } },
      create: { ...key, queryId: d.queryId, query: d.query, lastSeen: now },
      update: { query: d.query, lastSeen: now },
    });
  }
  return { totals, written: deltas.length };
}

export interface SlowQueriesView {
  windowHours: number;
  /** Snapshot cadence, so the UI can say "every 5 minutes". */
  everyMinutes: number;
  /** Oldest sample in the window (null = none yet). */
  since: string | null;
  rows: SlowQueryRow[];
  /** How p95 is computed, in plain words. */
  p95Note: string;
}

/** `studio.slowQueries` — this org's stored deltas for one database, summed over the window. */
export async function studioSlowQueries(
  ctx: OrgContext,
  input: { stack: string; target: string; hours?: number },
  now = Date.now(),
): Promise<SlowQueriesView> {
  const windowHours = input.hours ?? 24;
  const key = { orgId: ctx.activeOrgId, stack: input.stack, target: input.target };
  const tdb = telemetryOf(ctx);
  const samples = await tdb.pgQuerySample.findMany({
    where: { ...key, ts: { gte: new Date(now - windowHours * 3_600_000) } },
    select: { queryId: true, calls: true, totalMs: true, rows: true, ts: true },
    orderBy: { ts: 'asc' },
  });
  const rows = aggregateSlowQueries(samples, new Map());
  const texts = await tdb.pgQueryText.findMany({
    where: { ...key, queryId: { in: rows.map((r) => r.queryId) } },
    select: { queryId: true, query: true },
  });
  const byId = new Map(texts.map((x) => [x.queryId, x.query]));
  return {
    windowHours,
    everyMinutes: SLOW_SNAPSHOT_MS / 60_000,
    since: samples[0]?.ts.toISOString() ?? null,
    rows: rows.map((r) => ({ ...r, query: byId.get(r.queryId) ?? '' })),
    p95Note: 'p95 is estimated from each 5-minute average, weighted by calls: Postgres keeps no per-call times, so a single slow call in a busy window is averaged away.',
  };
}

/** Retention: drop samples (and texts not seen) older than the telemetry cutoff. */
export async function prunePgQuerySamples(tdb: TelemetryDB, cutoff: Date): Promise<void> {
  await tdb.pgQuerySample.deleteMany({ where: { ts: { lt: cutoff } } });
  await tdb.pgQueryText.deleteMany({ where: { lastSeen: { lt: cutoff } } });
}
