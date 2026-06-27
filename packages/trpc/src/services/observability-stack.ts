/**
 * Swarm `ServiceSpec`s for the swarmy-managed observability stack: a single
 * ClickHouse store + an OTel Collector gateway. These are plain specs handed to
 * the EXISTING `service.deploy` dispatch path — no new agent code, no new
 * protocol. Pinned images keep deploys reproducible.
 */
import type { ServiceSpec } from '@swarmy/core/protocol';
import {
  CLICKHOUSE_INIT_PATH,
  COLLECTOR_CONFIG_PATH,
  renderClickhouseInitSql,
  renderCollectorConfig,
  type RenderedFile,
} from './observability-render';

/** The overlay network apps' OTLP env points at (`otel-collector:4317`). */
export const OTEL_OVERLAY_NETWORK = 'swarmy';

/** Stable name the collector exporter + the read DSN use for ClickHouse. */
export const CLICKHOUSE_SERVICE_HOST = 'swarmy-clickhouse';

/** ClickHouse HTTP interface port (used for both reads and the DSN). */
export const CLICKHOUSE_HTTP_PORT = 8123;
/** ClickHouse native port (collector exporter target). */
export const CLICKHOUSE_NATIVE_PORT = 9000;

/** OTLP gRPC / HTTP receiver ports on the collector. */
export const OTLP_GRPC_PORT = 4317;
export const OTLP_HTTP_PORT = 4318;

const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.8-alpine';
const COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.111.0';

const MANAGED_LABELS: Record<string, string> = {
  'swarmy.managed': 'true',
  'swarmy.component': 'observability',
};

/** Host directory the agent writes the rendered config files into for bind mounts. */
const CLICKHOUSE_CONF_DIR = '/etc/swarmy/observability/clickhouse';
const COLLECTOR_CONF_DIR = '/etc/swarmy/observability/collector';
const CLICKHOUSE_INIT_HOST = `${CLICKHOUSE_CONF_DIR}/swarmy-init.sql`;
const COLLECTOR_CONFIG_HOST = `${COLLECTOR_CONF_DIR}/config.yaml`;

export function clickhouseServiceSpec(opts: {
  password: string;
  retentionDays: number;
}): ServiceSpec {
  return {
    name: 'swarmy-clickhouse',
    image: CLICKHOUSE_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: { ...MANAGED_LABELS, 'swarmy.role': 'store' },
    env: {
      CLICKHOUSE_USER: 'default',
      CLICKHOUSE_PASSWORD: opts.password,
      CLICKHOUSE_DB: 'otel',
      // Surfaced for the init DDL / TTL setup; harmless otherwise.
      SWARMY_RETENTION_DAYS: String(opts.retentionDays),
    },
    ports: [
      { target: CLICKHOUSE_HTTP_PORT, protocol: 'tcp', mode: 'ingress' },
      { target: CLICKHOUSE_NATIVE_PORT, protocol: 'tcp', mode: 'ingress' },
    ],
    mounts: [
      { type: 'volume', source: 'swarmy-clickhouse-data', target: '/var/lib/clickhouse' },
      // Init DDL (tables + TTLs) runs on first boot from the entrypoint dir.
      { type: 'bind', source: CLICKHOUSE_INIT_HOST, target: CLICKHOUSE_INIT_PATH, readOnly: true },
    ],
    networks: [OTEL_OVERLAY_NETWORK],
  };
}

export function collectorServiceSpec(opts: { clickhouseDsn: string }): ServiceSpec {
  return {
    name: 'swarmy-otel-collector',
    image: COLLECTOR_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: { ...MANAGED_LABELS, 'swarmy.role': 'collector' },
    args: ['--config', COLLECTOR_CONFIG_PATH],
    env: {
      // Retained for reference / debugging; the wiring lives in the config file.
      CLICKHOUSE_ENDPOINT: opts.clickhouseDsn,
    },
    ports: [
      { target: OTLP_GRPC_PORT, protocol: 'tcp', mode: 'ingress' },
      { target: OTLP_HTTP_PORT, protocol: 'tcp', mode: 'ingress' },
    ],
    mounts: [
      { type: 'bind', source: COLLECTOR_CONFIG_HOST, target: COLLECTOR_CONFIG_PATH, readOnly: true },
    ],
    networks: [OTEL_OVERLAY_NETWORK],
  };
}

/**
 * The rendered config files the deploy path must write to the manager host
 * (at their `path`) before deploying the specs above, so the bind mounts resolve.
 */
export function observabilityConfigFiles(opts: {
  password: string;
  retentionDays: number;
  database?: string;
}): RenderedFile[] {
  const database = opts.database ?? 'otel';
  return [
    {
      path: CLICKHOUSE_INIT_HOST,
      contents: renderClickhouseInitSql({ database, retentionDays: opts.retentionDays }),
      mode: 0o644,
    },
    {
      path: COLLECTOR_CONFIG_HOST,
      contents: renderCollectorConfig({
        clickhouseHost: CLICKHOUSE_SERVICE_HOST,
        clickhouseUser: 'default',
        clickhousePassword: opts.password,
        clickhouseDatabase: database,
      }),
      mode: 0o644,
    },
  ];
}
