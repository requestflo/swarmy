import { describe, expect, it } from 'bun:test';
import {
  buildDiskQuery,
  buildPartsByDayQuery,
  buildRetentionStatements,
  buildSpanRateQuery,
  buildTablesQuery,
  retentionSignature,
  summariseParts,
} from './observability-retention';

const RET = { tracesDays: 14, logsDays: 7, metricsDays: 30 };
const ALL = [
  'otel_traces',
  'otel_traces_trace_id_ts',
  'otel_logs',
  'otel_metrics_gauge',
  'otel_metrics_sum',
  'otel_metrics_histogram',
  'otel_metrics_exponential_histogram',
  'otel_metrics_summary',
];

describe('buildRetentionStatements (per-signal TTL)', () => {
  it('writes one MODIFY TTL per existing exporter table, by signal', () => {
    expect(buildRetentionStatements('otel', RET, ALL)).toEqual([
      'ALTER TABLE otel.otel_traces MODIFY TTL toDateTime(Timestamp) + toIntervalDay(14)',
      'ALTER TABLE otel.otel_traces_trace_id_ts MODIFY TTL toDateTime(Start) + toIntervalDay(14)',
      'ALTER TABLE otel.otel_logs MODIFY TTL toDateTime(Timestamp) + toIntervalDay(7)',
      'ALTER TABLE otel.otel_metrics_gauge MODIFY TTL toDateTime(TimeUnix) + toIntervalDay(30)',
      'ALTER TABLE otel.otel_metrics_sum MODIFY TTL toDateTime(TimeUnix) + toIntervalDay(30)',
      'ALTER TABLE otel.otel_metrics_histogram MODIFY TTL toDateTime(TimeUnix) + toIntervalDay(30)',
      'ALTER TABLE otel.otel_metrics_exponential_histogram MODIFY TTL toDateTime(TimeUnix) + toIntervalDay(30)',
      'ALTER TABLE otel.otel_metrics_summary MODIFY TTL toDateTime(TimeUnix) + toIntervalDay(30)',
    ]);
  });

  it('skips tables that do not exist yet and never touches other tables', () => {
    expect(buildRetentionStatements('otel', RET, ['otel_logs', 'swarmy_error_events'])).toEqual([
      'ALTER TABLE otel.otel_logs MODIFY TTL toDateTime(Timestamp) + toIntervalDay(7)',
    ]);
  });

  it('clamps days and refuses an unsafe database identifier', () => {
    expect(buildRetentionStatements('otel', { tracesDays: 9999, logsDays: 0, metricsDays: 30 }, ['otel_traces', 'otel_logs'])).toEqual([
      'ALTER TABLE otel.otel_traces MODIFY TTL toDateTime(Timestamp) + toIntervalDay(365)',
      'ALTER TABLE otel.otel_logs MODIFY TTL toDateTime(Timestamp) + toIntervalDay(1)',
    ]);
    expect(() => buildRetentionStatements('otel; DROP', RET, ALL)).toThrow();
  });

  it('signs the desired TTLs so a steady tick sends nothing', () => {
    expect(retentionSignature('otel', RET)).toBe('otel:14/7/30');
    expect(retentionSignature('otel', RET)).toBe(retentionSignature('otel', { ...RET }));
  });
});

describe('forecast SQL builders', () => {
  it('reads tables, parts per day and the store disk', () => {
    expect(buildTablesQuery('otel')).toBe("SELECT name FROM system.tables WHERE database = 'otel' AND name LIKE 'otel\\_%'");
    expect(buildPartsByDayQuery('otel')).toBe(
      [
        'SELECT table, partition, sum(bytes_on_disk) AS bytes',
        'FROM system.parts',
        "WHERE active AND database = 'otel' AND table LIKE 'otel\\_%'",
        'GROUP BY table, partition',
      ].join('\n'),
    );
    expect(buildDiskQuery()).toBe("SELECT free_space, total_space FROM system.disks WHERE name = 'default'");
  });

  it('scopes the span rate to the org and escapes it', () => {
    const sql = buildSpanRateQuery("o'1", 'otel');
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'o\\'1'");
    expect(sql).toContain('FROM otel.otel_traces');
    expect(sql).toContain('INTERVAL 300 SECOND');
  });
});

describe('summariseParts', () => {
  const NOW = Date.parse('2026-09-26T12:00:00Z');

  it('sums bytes per signal and averages full days in the last week (today excluded)', () => {
    const out = summariseParts(
      [
        { table: 'otel_traces', partition: '2026-09-26', bytes: 999 },
        { table: 'otel_traces', partition: '2026-09-25', bytes: 200 },
        { table: 'otel_traces_trace_id_ts', partition: '2026-09-25', bytes: 20 },
        { table: 'otel_traces', partition: '2026-09-24', bytes: '180' },
        { table: 'otel_traces', partition: '2026-09-01', bytes: 50 },
        { table: 'otel_logs', partition: '2026-09-25', bytes: 100 },
        { table: 'otel_metrics_sum', partition: '2026-09-26', bytes: 10 },
        { table: 'swarmy_error_events', partition: '2026-09-25', bytes: 5000 },
      ],
      NOW,
    );
    expect(out).toEqual([
      { signal: 'traces', bytes: 1449, bytesPerDay: 200 },
      { signal: 'logs', bytes: 100, bytesPerDay: 100 },
      // Only today's partition: the rate is unmeasured, not zero.
      { signal: 'metrics', bytes: 10, bytesPerDay: null },
    ]);
  });
});
