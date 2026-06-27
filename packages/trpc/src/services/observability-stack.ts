/**
 * Swarm `ServiceSpec`s for the swarmy-managed observability stack: a single
 * ClickHouse store + an OTel Collector gateway. These are plain specs handed to
 * the EXISTING `service.deploy` dispatch path — no new agent code, no new
 * protocol. Pinned images keep deploys reproducible.
 */
import type { ServiceSpec } from '@swarmy/core/protocol';

/** The overlay network apps' OTLP env points at (`otel-collector:4317`). */
export const OTEL_OVERLAY_NETWORK = 'swarmy';

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
      // Surfaced for the (future) init DDL / TTL setup; harmless otherwise.
      SWARMY_RETENTION_DAYS: String(opts.retentionDays),
    },
    ports: [
      { target: CLICKHOUSE_HTTP_PORT, protocol: 'tcp', mode: 'ingress' },
      { target: CLICKHOUSE_NATIVE_PORT, protocol: 'tcp', mode: 'ingress' },
    ],
    mounts: [
      { type: 'volume', source: 'swarmy-clickhouse-data', target: '/var/lib/clickhouse' },
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
    env: {
      // The collector config references this to wire its ClickHouse exporter.
      CLICKHOUSE_ENDPOINT: opts.clickhouseDsn,
    },
    ports: [
      { target: OTLP_GRPC_PORT, protocol: 'tcp', mode: 'ingress' },
      { target: OTLP_HTTP_PORT, protocol: 'tcp', mode: 'ingress' },
    ],
    networks: [OTEL_OVERLAY_NETWORK],
  };
}
