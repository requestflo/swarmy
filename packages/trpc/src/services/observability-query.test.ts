import { describe, expect, it } from 'bun:test';
import {
  buildMetricsSeriesQuery,
  buildMetricsSummaryQuery,
  buildTraceDetailQuery,
  buildTracesQuery,
} from './observability-query';

const ORG = 'org_abc123';

describe('buildTracesQuery', () => {
  it('always org-scopes and selects root spans only', () => {
    const sql = buildTracesQuery(ORG, {});
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain("ParentSpanId = ''");
    expect(sql).toContain('LIMIT 100');
  });

  it('applies service / stack / duration / error filters', () => {
    const sql = buildTracesQuery(ORG, {
      service: 'api',
      stack: 'shop',
      minDurationMs: 250,
      errorsOnly: true,
    });
    expect(sql).toContain("ServiceName = 'api'");
    expect(sql).toContain("ResourceAttributes['swarmy.stack'] = 'shop'");
    expect(sql).toContain('Duration >= 250000000'); // ms -> ns
    expect(sql).toContain("StatusCode != 'STATUS_CODE_OK'");
  });

  it('clamps window and limit', () => {
    const sql = buildTracesQuery(ORG, { windowMinutes: 999999, limit: 99999 });
    expect(sql).toContain('INTERVAL 10080 MINUTE'); // 7 days
    expect(sql).toContain('LIMIT 500');
  });

  it('escapes single quotes to prevent injection through filters', () => {
    const sql = buildTracesQuery(ORG, { service: "a' OR '1'='1" });
    expect(sql).toContain("ServiceName = 'a\\' OR \\'1\\'=\\'1'");
    expect(sql).not.toContain("OR '1'='1'");
  });
});

describe('buildTraceDetailQuery', () => {
  it('org-scopes and pins to one trace id, root span first', () => {
    const sql = buildTraceDetailQuery(ORG, { traceId: 'deadbeef' });
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain("TraceId = 'deadbeef'");
    expect(sql).toContain("ORDER BY ParentSpanId = '' DESC");
  });

  it('escapes the trace id', () => {
    const sql = buildTraceDetailQuery(ORG, { traceId: "x'; DROP TABLE otel_traces; --" });
    expect(sql).toContain("TraceId = 'x\\'; DROP TABLE otel_traces; --'");
  });

  it('selects waterfall columns including parent span and nanos offset', () => {
    const sql = buildTraceDetailQuery(ORG, { traceId: 't1' });
    expect(sql).toContain('ParentSpanId AS parent_span_id');
    expect(sql).toContain('toUnixTimestamp64Nano(Timestamp)');
    expect(sql).toContain('SpanKind AS span_kind');
  });
});

describe('buildMetricsSeriesQuery', () => {
  it('org-scopes, buckets, and orders ascending', () => {
    const sql = buildMetricsSeriesQuery(ORG, { metric: 'http.server.duration' });
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain("MetricName = 'http.server.duration'");
    expect(sql).toContain('INTERVAL 60 SECOND');
    expect(sql).toContain('ORDER BY bucket ASC');
  });

  it('clamps the bucket width', () => {
    expect(buildMetricsSeriesQuery(ORG, { metric: 'm', bucketSeconds: 999999 })).toContain(
      'INTERVAL 3600 SECOND',
    );
    expect(buildMetricsSeriesQuery(ORG, { metric: 'm', bucketSeconds: 1 })).toContain(
      'INTERVAL 5 SECOND',
    );
  });
});

describe('buildMetricsSummaryQuery', () => {
  it('org-scopes, groups by service, orders by avg desc', () => {
    const sql = buildMetricsSummaryQuery(ORG, { metric: 'http.server.duration' });
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain('GROUP BY service_name');
    expect(sql).toContain('ORDER BY avg_value DESC');
    expect(sql).toContain('LIMIT 50');
  });

  it('filters by stack when given and clamps the limit', () => {
    const sql = buildMetricsSummaryQuery(ORG, { metric: 'm', stack: 'shop', limit: 99999 });
    expect(sql).toContain("ResourceAttributes['swarmy.stack'] = 'shop'");
    expect(sql).toContain('LIMIT 200');
  });
});
