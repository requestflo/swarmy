import { describe, expect, it } from 'bun:test';
import {
  buildServiceMapNodesQuery,
  buildServiceMapQuery,
  composeServiceMap,
  redDegraded,
  windowEnd,
} from './observability-map';

const ORG = 'org_abc123';

describe('buildServiceMapQuery (edges)', () => {
  it('org-scopes BOTH join sides and pairs client→server span kinds', () => {
    const sql = buildServiceMapQuery(ORG, {});
    expect(sql).toContain("s.ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain("c.ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain("s.SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER')");
    expect(sql).toContain("c.SpanKind IN ('SPAN_KIND_CLIENT', 'SPAN_KIND_PRODUCER')");
    expect(sql).toContain('c.SpanId = s.ParentSpanId');
    expect(sql).toContain('c.ServiceName != s.ServiceName');
  });

  it('defaults to a 15 minute window and clamps out-of-range values', () => {
    expect(buildServiceMapQuery(ORG, {})).toContain('INTERVAL 15 MINUTE');
    expect(buildServiceMapQuery(ORG, { windowMinutes: 999999 })).toContain('INTERVAL 1440 MINUTE');
    expect(buildServiceMapQuery(ORG, { windowMinutes: 0 })).toContain('INTERVAL 1 MINUTE');
  });

  it('measures error rate and p95 on the server side', () => {
    const sql = buildServiceMapQuery(ORG, {});
    expect(sql).toContain("countIf(s.StatusCode = 'STATUS_CODE_ERROR')");
    expect(sql).toContain('quantile(0.95)(s.Duration)');
  });

  it('escapes a hostile org id', () => {
    const sql = buildServiceMapQuery("o'; DROP TABLE otel_traces; --", {});
    expect(sql).toContain("= 'o\\'; DROP TABLE otel_traces; --'");
  });

  it('can end the window at a past moment, bounded on both sides (Time travel)', () => {
    const end = "parseDateTime64BestEffort('2026-10-22T14:00:00.000Z', 3)";
    const sql = buildServiceMapQuery(ORG, { until: '2026-10-22T14:00:00Z' });
    expect(sql).toContain(`s.Timestamp >= ${end} - INTERVAL 15 MINUTE`);
    expect(sql).toContain(`s.Timestamp <= ${end}`);
    expect(sql).toContain(`c.Timestamp >= ${end} - INTERVAL 20 MINUTE`);
    expect(sql).not.toContain('now()');
    expect(buildServiceMapNodesQuery(ORG, { until: '2026-10-22T14:00:00Z' })).toContain(`Timestamp <= ${end}`);
  });

  it('only a real time reaches the SQL: anything else is now', () => {
    const sql = buildServiceMapQuery(ORG, { until: "x'); DROP TABLE otel_traces; --" });
    expect(sql).toContain('s.Timestamp >= now() - INTERVAL 15 MINUTE');
    expect(sql).not.toContain('DROP');
    expect(windowEnd(undefined).end).toBe('now()');
  });
});

describe('buildServiceMapNodesQuery', () => {
  it('org-scopes and counts entry spans (server/consumer or root)', () => {
    const sql = buildServiceMapNodesQuery(ORG, {});
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'org_abc123'");
    expect(sql).toContain("(SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')");
    expect(sql).toContain('GROUP BY service_name');
  });

  it('clamps the window', () => {
    expect(buildServiceMapNodesQuery(ORG, { windowMinutes: 999999 })).toContain('INTERVAL 1440 MINUTE');
  });
});

describe('composeServiceMap', () => {
  const nodeRows = [
    { service_name: 'web', calls: 300, error_rate: 0.01, p95_ms: 240 },
    { service_name: 'checkout', calls: 150, error_rate: 0.062, p95_ms: 1820 },
  ];
  const edgeRows = [
    { from_service: 'web', to_service: 'checkout', calls: 150, error_rate: 0.062, p95_ms: 1820 },
    { from_service: 'cron', to_service: 'web', calls: 15, error_rate: 0, p95_ms: 80 },
  ];

  it('converts calls to per-minute rates over the window', () => {
    const { nodes, edges } = composeServiceMap(nodeRows, edgeRows, 15);
    expect(nodes.find((n) => n.id === 'web')?.callsPerMin).toBe(20);
    expect(edges[0]?.callsPerMin).toBe(10);
    expect(edges[1]?.callsPerMin).toBe(1);
  });

  it('tints nodes degraded above the RED thresholds', () => {
    const { nodes } = composeServiceMap(nodeRows, edgeRows, 15);
    expect(nodes.find((n) => n.id === 'web')?.degraded).toBe(false);
    expect(nodes.find((n) => n.id === 'checkout')?.degraded).toBe(true);
  });

  it('adds placeholder nodes for services that only appear on edges', () => {
    const { nodes } = composeServiceMap(nodeRows, edgeRows, 15);
    const cron = nodes.find((n) => n.id === 'cron');
    expect(cron).toEqual({ id: 'cron', callsPerMin: 0, errorRate: 0, p95Ms: 0, degraded: false });
  });
});

describe('redDegraded', () => {
  it('breaches on error rate OR p95', () => {
    expect(redDegraded(0.051, 100)).toBe(true);
    expect(redDegraded(0.01, 1501)).toBe(true);
    expect(redDegraded(0.05, 1500)).toBe(false);
  });
});
