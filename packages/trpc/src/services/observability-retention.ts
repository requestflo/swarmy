/**
 * Per-signal retention + the disk forecast over the telemetry store. Pure SQL
 * builders and row folds — no IO — so they are golden-tested.
 *
 * Retention is a ClickHouse TTL on each table the collector's exporter
 * creates (`create_schema: true` — the exporter owns the schema). The exporter
 * sets ONE `ttl` at CREATE time only, so a per-signal or changed retention is
 * applied here as `ALTER TABLE … MODIFY TTL` on each existing table. Nothing
 * deletes rows directly: ClickHouse drops expired parts at its next merge
 * (the exporter sets `ttl_only_drop_parts = 1`).
 *
 * Column names are the exporter's for the pinned contrib image
 * (`otel/opentelemetry-collector-contrib:0.111.0`).
 */
import type { TelemetrySettings, TelemetrySignal, TelemetrySignalUsage } from '@swarmy/core';

export interface SignalTable {
  table: string;
  /** The row's time column the TTL counts from. */
  timeColumn: string;
}

/** Every exporter table, by the signal whose retention it follows. */
export const SIGNAL_TABLES: Record<TelemetrySignal, readonly SignalTable[]> = {
  traces: [
    { table: 'otel_traces', timeColumn: 'Timestamp' },
    { table: 'otel_traces_trace_id_ts', timeColumn: 'Start' },
  ],
  logs: [{ table: 'otel_logs', timeColumn: 'Timestamp' }],
  metrics: [
    'otel_metrics_gauge',
    'otel_metrics_sum',
    'otel_metrics_histogram',
    'otel_metrics_exponential_histogram',
    'otel_metrics_summary',
  ].map((table) => ({ table, timeColumn: 'TimeUnix' })),
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier ${name}`);
  return name;
}

function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function days(n: number): number {
  return Math.min(365, Math.max(1, Math.floor(Number.isFinite(n) ? n : 7)));
}

/** The signal a table's retention follows, or null for tables swarmy doesn't manage. */
export function signalForTable(table: string): TelemetrySignal | null {
  for (const [signal, tables] of Object.entries(SIGNAL_TABLES) as Array<[TelemetrySignal, readonly SignalTable[]]>) {
    if (tables.some((t) => t.table === table)) return signal;
  }
  return null;
}

/** The exporter tables that exist now (`system.tables`). */
export function buildTablesQuery(database: string): string {
  return `SELECT name FROM system.tables WHERE database = ${lit(ident(database))} AND name LIKE 'otel\\_%'`;
}

/**
 * `ALTER TABLE … MODIFY TTL` per existing exporter table, from the per-signal
 * retention. Tables that don't exist yet are skipped (the exporter creates
 * them with the longest retention; the next reconcile narrows them).
 */
export function buildRetentionStatements(
  database: string,
  retention: TelemetrySettings['retention'],
  existingTables: readonly string[],
): string[] {
  const db = ident(database);
  const have = new Set(existingTables);
  const perSignal: Record<TelemetrySignal, number> = {
    traces: days(retention.tracesDays),
    logs: days(retention.logsDays),
    metrics: days(retention.metricsDays),
  };
  return (Object.keys(SIGNAL_TABLES) as TelemetrySignal[]).flatMap((signal) =>
    SIGNAL_TABLES[signal]
      .filter((t) => have.has(t.table))
      .map(
        (t) =>
          `ALTER TABLE ${db}.${ident(t.table)} MODIFY TTL toDateTime(${ident(t.timeColumn)}) + toIntervalDay(${perSignal[signal]})`,
      ),
  );
}

/** A deterministic signature of the desired TTLs (the reconcile gate). */
export function retentionSignature(database: string, retention: TelemetrySettings['retention']): string {
  return `${database}:${days(retention.tracesDays)}/${days(retention.logsDays)}/${days(retention.metricsDays)}`;
}

/** Active part bytes per exporter table per partition (a day, `toDate(...)`). */
export function buildPartsByDayQuery(database: string): string {
  return [
    'SELECT table, partition, sum(bytes_on_disk) AS bytes',
    'FROM system.parts',
    `WHERE active AND database = ${lit(ident(database))} AND table LIKE 'otel\\_%'`,
    'GROUP BY table, partition',
  ].join('\n');
}

/** Free / total bytes on the disk ClickHouse writes to. */
export function buildDiskQuery(): string {
  return "SELECT free_space, total_space FROM system.disks WHERE name = 'default'";
}

/** Spans this org stored over the last 5 minutes (after sampling). Org-scoped. */
export const SPAN_RATE_WINDOW_S = 300;
export function buildSpanRateQuery(orgId: string, database: string): string {
  return [
    'SELECT count() AS spans',
    `FROM ${ident(database)}.otel_traces`,
    `WHERE ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `  AND Timestamp >= now() - INTERVAL ${SPAN_RATE_WINDOW_S} SECOND`,
  ].join('\n');
}

export interface PartsRow {
  table: string;
  partition: string;
  bytes: number | string;
}

const DAY_MS = 86_400_000;

/** UTC day key `YYYY-MM-DD` for a ms timestamp. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fold `system.parts` rows into bytes now + the average bytes per full day
 * over the last 7 days, per signal. Today (still filling) never counts toward
 * the rate. A signal with no dated partition in that window has a null rate —
 * unmeasured, never a guessed zero.
 */
export function summariseParts(rows: readonly PartsRow[], nowMs: number): TelemetrySignalUsage[] {
  const window = new Set(Array.from({ length: 7 }, (_, i) => dayKey(nowMs - (i + 1) * DAY_MS)));
  const acc: Record<TelemetrySignal, { bytes: number; perDay: Map<string, number> }> = {
    traces: { bytes: 0, perDay: new Map() },
    logs: { bytes: 0, perDay: new Map() },
    metrics: { bytes: 0, perDay: new Map() },
  };
  for (const r of rows) {
    const signal = signalForTable(r.table);
    if (!signal) continue;
    const b = Number(r.bytes);
    if (!Number.isFinite(b)) continue;
    acc[signal].bytes += b;
    const day = String(r.partition).replace(/^'|'$/g, '');
    if (window.has(day)) acc[signal].perDay.set(day, (acc[signal].perDay.get(day) ?? 0) + b);
  }
  return (Object.keys(acc) as TelemetrySignal[]).map((signal) => {
    const perDay = [...acc[signal].perDay.values()];
    return {
      signal,
      bytes: acc[signal].bytes,
      bytesPerDay: perDay.length ? perDay.reduce((a, b) => a + b, 0) / perDay.length : null,
    };
  });
}
