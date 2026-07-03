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
    // The exporter owns the schema so its INSERT column set always matches.
    expect(yaml).toContain('create_schema: true');
  });

  it('sets the exporter TTL from retentionDays (hours), clamped', () => {
    expect(renderCollectorConfig({ ...COLLECTOR_INPUT, retentionDays: 7 })).toContain('ttl: 168h');
    expect(renderCollectorConfig({ ...COLLECTOR_INPUT, retentionDays: 30 })).toContain('ttl: 720h');
    expect(renderCollectorConfig({ ...COLLECTOR_INPUT, retentionDays: 99999 })).toContain('ttl: 8760h');
    expect(renderCollectorConfig({ ...COLLECTOR_INPUT, retentionDays: 0 })).toContain('ttl: 24h');
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

  it('only ensures the database — the collector exporter creates the tables', () => {
    const sql = renderClickhouseInitSql({ database: 'otel', retentionDays: 7 });
    expect(sql).toContain('CREATE DATABASE IF NOT EXISTS otel;');
    // No hand-rolled table DDL — that drifted from the exporter and broke inserts.
    expect(sql).not.toContain('CREATE TABLE');
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
    expect(files.clickhouseInit.contents).toContain('CREATE DATABASE IF NOT EXISTS otel;');
  });

  it('threads store retention into the collector exporter TTL', () => {
    const files = renderObservabilityFiles({
      collector: COLLECTOR_INPUT,
      store: { database: 'otel', retentionDays: 14 },
    });
    expect(files.collectorConfig.contents).toContain('ttl: 336h');
  });
});
