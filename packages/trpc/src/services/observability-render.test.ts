import { describe, expect, it } from 'bun:test';
import { defaultTelemetrySettings, renderTelemetryProcessors } from '@swarmy/core';
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
  clickhousePasswordFile: '/run/secrets/clickhouse-password',
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
    // The password is a Docker-secret file reference, never the value.
    expect(yaml).toContain('password: ${file:/run/secrets/clickhouse-password}');
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

describe('renderCollectorConfig with telemetry settings (ObsSettings)', () => {
  const telemetry = {
    sampling: { keepErrors: true as const, slowTraceMs: 1000, restPercent: 25 },
    retention: { tracesDays: 14, logsDays: 14, metricsDays: 30 },
    redaction: defaultTelemetrySettings().redaction,
  };

  it('splices the sampling + redaction processors in pipeline order (golden)', () => {
    const yaml = renderCollectorConfig({ ...COLLECTOR_INPUT, telemetry });
    expect(yaml.slice(yaml.indexOf('service:'))).toBe(
      [
        'service:',
        '  pipelines:',
        '    traces:',
        '      receivers: [otlp]',
        '      processors: [resource, attributes/redact_spans, transform/redact_spans, tail_sampling, batch]',
        '      exporters: [clickhouse]',
        '    metrics:',
        '      receivers: [otlp]',
        '      processors: [resource, batch]',
        '      exporters: [clickhouse]',
        '    logs:',
        '      receivers: [otlp]',
        '      processors: [resource, attributes/redact_logs, transform/redact_logs, batch]',
        '      exporters: [clickhouse]',
        '',
      ].join('\n'),
    );
    // The processors block is the same pure render the dashboard's Code view shows.
    const processors = yaml.slice(yaml.indexOf('processors:'), yaml.indexOf('exporters:'));
    for (const line of renderTelemetryProcessors(telemetry).lines) expect(processors).toContain(line);
    expect(processors.indexOf('  resource:')).toBeLessThan(processors.indexOf('  tail_sampling:'));
  });

  it('creates tables with the LONGEST retention (per-table TTLs narrow them after)', () => {
    expect(renderCollectorConfig({ ...COLLECTOR_INPUT, retentionDays: 7, telemetry })).toContain('ttl: 720h');
  });

  it('keeps everything (no sampler) at 100% and changes the render when settings change', () => {
    const keepAll = { ...telemetry, sampling: { ...telemetry.sampling, restPercent: 100 } };
    const a = renderCollectorConfig({ ...COLLECTOR_INPUT, telemetry: keepAll });
    expect(a).not.toContain('tail_sampling');
    expect(a).not.toBe(renderCollectorConfig({ ...COLLECTOR_INPUT, telemetry }));
  });
});
