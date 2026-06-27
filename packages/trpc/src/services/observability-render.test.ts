import { describe, expect, it } from 'bun:test';
import {
  CLICKHOUSE_INIT_PATH,
  COLLECTOR_CONFIG_PATH,
  renderClickhouseInitSql,
  renderCollectorConfig,
  renderObservabilityFiles,
} from './observability-render';

const COLLECTOR_INPUT = {
  clickhouseHost: 'swarmy-clickhouse',
  clickhouseUser: 'default',
  clickhousePassword: 's3cr3t-pw',
  clickhouseDatabase: 'otel',
} as const;

describe('renderCollectorConfig', () => {
  it('is a stable golden YAML', () => {
    expect(renderCollectorConfig(COLLECTOR_INPUT)).toMatchSnapshot();
  });

  it('wires OTLP receivers, batch processor and the clickhouse exporter', () => {
    const yaml = renderCollectorConfig(COLLECTOR_INPUT);
    expect(yaml).toContain('endpoint: 0.0.0.0:4317');
    expect(yaml).toContain('endpoint: 0.0.0.0:4318');
    expect(yaml).toContain('batch:');
    expect(yaml).toContain('clickhouse:');
    expect(yaml).toContain('tcp://swarmy-clickhouse:9000');
    expect(yaml).toContain('database: otel');
    expect(yaml).toContain('password: s3cr3t-pw');
    expect(yaml).toContain('create_schema: false');
  });

  it('declares traces, metrics and logs pipelines', () => {
    const yaml = renderCollectorConfig(COLLECTOR_INPUT);
    expect(yaml).toContain('    traces:');
    expect(yaml).toContain('    metrics:');
    expect(yaml).toContain('    logs:');
  });

  it('clamps the batch timeout into [1,60] and is deterministic', () => {
    const a = renderCollectorConfig({ ...COLLECTOR_INPUT, batchTimeoutSeconds: 999 });
    expect(a).toContain('timeout: 60s');
    const b = renderCollectorConfig({ ...COLLECTOR_INPUT, batchTimeoutSeconds: 0 });
    expect(b).toContain('timeout: 1s');
    expect(renderCollectorConfig(COLLECTOR_INPUT)).toBe(renderCollectorConfig(COLLECTOR_INPUT));
  });
});

describe('renderClickhouseInitSql', () => {
  it('is a stable golden DDL', () => {
    expect(renderClickhouseInitSql({ database: 'otel', retentionDays: 7 })).toMatchSnapshot();
  });

  it('creates the three signal tables and the database', () => {
    const sql = renderClickhouseInitSql({ database: 'otel', retentionDays: 7 });
    expect(sql).toContain('CREATE DATABASE IF NOT EXISTS otel;');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS otel.otel_traces');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS otel.otel_metrics_gauge');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS otel.otel_metrics_sum');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS otel.otel_logs');
  });

  it('applies the retention TTL from retentionDays to every table', () => {
    const sql = renderClickhouseInitSql({ database: 'otel', retentionDays: 30 });
    const ttls = sql.match(/TTL .* \+ INTERVAL 30 DAY/g) ?? [];
    expect(ttls.length).toBe(4); // traces, gauge, sum, logs
  });

  it('clamps retentionDays into [1,365]', () => {
    expect(renderClickhouseInitSql({ database: 'otel', retentionDays: 99999 })).toContain(
      'INTERVAL 365 DAY',
    );
    expect(renderClickhouseInitSql({ database: 'otel', retentionDays: 0 })).toContain(
      'INTERVAL 1 DAY',
    );
  });

  it('org-prunes by putting swarmy.org_id first in every ORDER BY', () => {
    const sql = renderClickhouseInitSql({ database: 'otel', retentionDays: 7 });
    const orderBys = sql.match(/ORDER BY \(ResourceAttributes\['swarmy.org_id'\]/g) ?? [];
    expect(orderBys.length).toBe(4);
  });
});

describe('renderObservabilityFiles', () => {
  it('returns both config files at their mount paths', () => {
    const files = renderObservabilityFiles({
      collector: COLLECTOR_INPUT,
      store: { database: 'otel', retentionDays: 7 },
    });
    expect(files.collectorConfig.path).toBe(COLLECTOR_CONFIG_PATH);
    expect(files.clickhouseInit.path).toBe(CLICKHOUSE_INIT_PATH);
    expect(files.collectorConfig.contents).toContain('receivers:');
    expect(files.clickhouseInit.contents).toContain('CREATE TABLE IF NOT EXISTS');
  });
});
