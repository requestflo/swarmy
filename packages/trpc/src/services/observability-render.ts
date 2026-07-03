/**
 * Pure renderers for the swarmy-managed observability store (epic #10, Phase 2).
 *
 * Two responsibilities, both pure (no IO) so they are trivially golden-tested:
 *  1. `renderCollectorConfig` — the OTel Collector `config.yaml`: OTLP receivers
 *     (gRPC + HTTP), batch + resource processors, and the ClickHouse exporter.
 *  2. `renderClickhouseInitSql` — the ClickHouse init DDL: `otel_traces`,
 *     `otel_metrics_gauge`/`otel_metrics_sum`, and `otel_logs` tables, each
 *     `PARTITION BY toDate(...)` with a `TTL ... + INTERVAL <retentionDays> DAY`
 *     so retention is enforced at the storage layer (no Postgres delete worker).
 *
 * The table layout mirrors the OTel Collector ClickHouse exporter schema so the
 * read-path SQL builders (`observability-query.ts`) and any Jaeger/Grafana
 * escape-hatch tooling line up with what the collector writes.
 *
 * Output is consumed two ways:
 *  - Files are mounted into the deployed services via the existing deploy path
 *    (collector `--config`, ClickHouse `/docker-entrypoint-initdb.d`).
 *  - The init SQL is also runnable directly over the ClickHouse HTTP interface
 *    (the service replays it after first deploy as a belt-and-braces step).
 */

import {
  CLICKHOUSE_NATIVE_PORT,
  OTLP_GRPC_PORT,
  OTLP_HTTP_PORT,
} from './observability-stack';

export interface RenderedFile {
  path: string;
  contents: string;
  mode?: number;
}

export interface CollectorRenderInput {
  /** ClickHouse native endpoint the exporter writes to (host:port). */
  clickhouseHost: string;
  clickhousePort?: number;
  clickhouseUser: string;
  clickhousePassword: string;
  clickhouseDatabase: string;
  /** Batch flush interval; bounded for determinism. Default 5s. */
  batchTimeoutSeconds?: number;
  /** Data retention; becomes the exporter's per-table TTL. Default 7 days. */
  retentionDays?: number;
}

export interface StoreInitInput {
  database: string;
  /** Retention window, applied as a ClickHouse TTL to every signal table. */
  retentionDays: number;
}

/** Default mount path for the rendered collector config inside the container. */
export const COLLECTOR_CONFIG_PATH = '/etc/otelcol-contrib/config.yaml';
/** Default mount path for the rendered ClickHouse init DDL. */
export const CLICKHOUSE_INIT_PATH = '/docker-entrypoint-initdb.d/swarmy-init.sql';

function clampInt(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : def;
  return Math.min(max, Math.max(min, v));
}

/* ----------------------------------------------------------------------------
 * Collector config.yaml
 * ------------------------------------------------------------------------- */

/**
 * Render the OTel Collector `config.yaml`. Deterministic for a given input so a
 * golden test can pin it byte-for-byte.
 *
 * Receivers: OTLP gRPC (4317) + HTTP (4318). Processors: `resource` stamps the
 * managed marker, `batch` for write efficiency. Exporter: `clickhouse` writing
 * traces/metrics/logs into swarmy's tables.
 */
export function renderCollectorConfig(input: CollectorRenderInput): string {
  const port = input.clickhousePort ?? CLICKHOUSE_NATIVE_PORT;
  const batch = clampInt(input.batchTimeoutSeconds, 5, 1, 60);
  const endpoint = `tcp://${input.clickhouseHost}:${port}?dial_timeout=10s&compress=lz4`;

  return [
    '# Managed by swarmy (observability). Do not edit by hand.',
    'receivers:',
    '  otlp:',
    '    protocols:',
    '      grpc:',
    `        endpoint: 0.0.0.0:${OTLP_GRPC_PORT}`,
    '      http:',
    `        endpoint: 0.0.0.0:${OTLP_HTTP_PORT}`,
    '',
    'processors:',
    '  batch:',
    `    timeout: ${batch}s`,
    '    send_batch_size: 5000',
    '  resource:',
    '    attributes:',
    '      - key: swarmy.managed',
    '        value: "true"',
    '        action: upsert',
    '',
    'exporters:',
    '  clickhouse:',
    `    endpoint: ${endpoint}`,
    `    database: ${input.clickhouseDatabase}`,
    `    username: ${input.clickhouseUser}`,
    `    password: ${input.clickhousePassword}`,
    '    traces_table_name: otel_traces',
    '    logs_table_name: otel_logs',
    // The exporter OWNS the schema: its INSERT always references its full column
    // set (TraceState, Events.*, Links.*, …), so a hand-rolled narrower schema
    // fails ("No such column TraceState"). Let it CREATE the tables to match its
    // own writer exactly; swarmy's queries use only standard columns it emits.
    '    create_schema: true',
    `    ttl: ${clampInt(input.retentionDays, 7, 1, 365) * 24}h`,
    '    timeout: 10s',
    '    retry_on_failure:',
    '      enabled: true',
    '      initial_interval: 5s',
    '      max_interval: 30s',
    '',
    'service:',
    '  pipelines:',
    '    traces:',
    '      receivers: [otlp]',
    '      processors: [resource, batch]',
    '      exporters: [clickhouse]',
    '    metrics:',
    '      receivers: [otlp]',
    '      processors: [resource, batch]',
    '      exporters: [clickhouse]',
    '    logs:',
    '      receivers: [otlp]',
    '      processors: [resource, batch]',
    '      exporters: [clickhouse]',
    '',
  ].join('\n');
}

/* ----------------------------------------------------------------------------
 * ClickHouse init DDL
 * ------------------------------------------------------------------------- */

/**
 * Render the ClickHouse init DDL: create the database and the
 * traces/metrics/logs tables, each partitioned by day and TTL'd by
 * `retentionDays`. `swarmy.org_id` participates in the sort key so every
 * controller query is org-pruned at the storage layer.
 *
 * Deterministic for a given input — pinned by a golden test.
 */
export function renderClickhouseInitSql(input: StoreInitInput): string {
  // The collector exporter now owns the traces/metrics/logs tables
  // (create_schema: true) so their DDL matches its writer exactly. We only
  // ensure the database exists; retention is the exporter `ttl`.
  return `-- Managed by swarmy (observability). Do not edit by hand.\nCREATE DATABASE IF NOT EXISTS ${input.database};\n`;
}

/** Render both config files for the deploy path (mounted into the services). */
export function renderObservabilityFiles(opts: {
  collector: CollectorRenderInput;
  store: StoreInitInput;
}): { collectorConfig: RenderedFile; clickhouseInit: RenderedFile } {
  return {
    collectorConfig: {
      path: COLLECTOR_CONFIG_PATH,
      // Retention lives on the store; the collector exporter enforces it as a
      // per-table TTL now that it owns the schema.
      contents: renderCollectorConfig({ ...opts.collector, retentionDays: opts.store.retentionDays }),
      mode: 0o644,
    },
    clickhouseInit: {
      path: CLICKHOUSE_INIT_PATH,
      contents: renderClickhouseInitSql(opts.store),
      mode: 0o644,
    },
  };
}
