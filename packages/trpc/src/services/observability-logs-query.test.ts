import { describe, expect, it } from 'bun:test';
import { buildLogsQuery } from './observability-query';

const ORG = 'org_abc123';
const FROM = Date.UTC(2026, 6, 2, 10, 0, 0); // 2026-07-02T10:00:00Z
const TO = FROM + 60 * 60 * 1000;

describe('buildLogsQuery', () => {
  it('always org-scopes first and bounds the closed time window', () => {
    const sql = buildLogsQuery(ORG, { from: FROM, to: TO });
    const whereLine = sql.split('\n').find((l) => l.startsWith('WHERE'))!;
    expect(whereLine.startsWith(`WHERE ResourceAttributes['swarmy.org_id'] = 'org_abc123'`)).toBe(
      true,
    );
    expect(sql).toContain(`Timestamp >= fromUnixTimestamp64Milli(${FROM})`);
    expect(sql).toContain(`Timestamp <= fromUnixTimestamp64Milli(${TO})`);
  });

  it('orders newest-first with the default limit', () => {
    const sql = buildLogsQuery(ORG, { from: FROM, to: TO });
    expect(sql).toContain('ORDER BY Timestamp DESC');
    expect(sql).toContain('LIMIT 200');
  });

  it('selects the otel_logs columns the view reads (incl. the ts_nano cursor)', () => {
    const sql = buildLogsQuery(ORG, { from: FROM, to: TO });
    expect(sql).toContain('FROM otel_logs');
    expect(sql).toContain('toString(Timestamp) AS timestamp');
    expect(sql).toContain('toString(toUnixTimestamp64Nano(Timestamp)) AS ts_nano');
    expect(sql).toContain('TraceId AS trace_id');
    expect(sql).toContain('SpanId AS span_id');
    expect(sql).toContain('SeverityText AS severity_text');
    expect(sql).toContain('SeverityNumber AS severity_number');
    expect(sql).toContain('ServiceName AS service_name');
    expect(sql).toContain('Body AS body');
    expect(sql).toContain('LogAttributes AS attributes');
  });

  it('applies service / severity / trace filters', () => {
    const sql = buildLogsQuery(ORG, {
      from: FROM,
      to: TO,
      serviceName: 'api',
      severityMin: 17,
      traceId: 'deadbeef',
    });
    expect(sql).toContain("ServiceName = 'api'");
    expect(sql).toContain('SeverityNumber >= 17');
    expect(sql).toContain("TraceId = 'deadbeef'");
  });

  it('search becomes a body ILIKE with escaped LIKE metacharacters', () => {
    const sql = buildLogsQuery(ORG, { from: FROM, to: TO, search: '100%_done' });
    expect(sql).toContain("Body ILIKE '%100\\\\%\\\\_done%'");
  });

  it('escapes single quotes in every string filter (no injection)', () => {
    const sql = buildLogsQuery(ORG, {
      from: FROM,
      to: TO,
      serviceName: "a' OR '1'='1",
      search: "x'; DROP TABLE otel_logs; --",
    });
    expect(sql).toContain("ServiceName = 'a\\' OR \\'1\\'=\\'1'");
    // quote escaped for the literal; the `_` in `otel_logs` LIKE-escaped too.
    expect(sql).toContain("Body ILIKE '%x\\'; DROP TABLE otel\\\\_logs; --%'");
    expect(sql).not.toContain("OR '1'='1'");
  });

  it('applies a digits-only keyset cursor as a strict upper bound', () => {
    const sql = buildLogsQuery(ORG, { from: FROM, to: TO, cursor: '1751450000000000000' });
    expect(sql).toContain('toUnixTimestamp64Nano(Timestamp) < 1751450000000000000');
  });

  it('ignores a non-numeric cursor entirely', () => {
    const sql = buildLogsQuery(ORG, { from: FROM, to: TO, cursor: "1; DROP TABLE x; --" });
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('toUnixTimestamp64Nano(Timestamp) <');
  });

  it('clamps limit, severity, and a to-before-from window', () => {
    const sql = buildLogsQuery(ORG, {
      from: FROM,
      to: FROM - 5000, // inverted window collapses to [from, from]
      limit: 99999,
      severityMin: 999 as number,
    });
    expect(sql).toContain('LIMIT 500');
    expect(sql).toContain('SeverityNumber >= 24');
    expect(sql).toContain(`Timestamp <= fromUnixTimestamp64Milli(${FROM})`);
  });

  it('floors fractional millisecond bounds to integers', () => {
    const sql = buildLogsQuery(ORG, { from: FROM + 0.75, to: TO + 0.25 });
    expect(sql).toContain(`fromUnixTimestamp64Milli(${FROM})`);
    expect(sql).toContain(`fromUnixTimestamp64Milli(${TO})`);
  });
});
