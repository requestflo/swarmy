import { describe, expect, it } from 'bun:test';
import {
  buildRequestSeriesManyQuery,
  groupRequestSeries,
  REQUEST_SERIES_MANY_MAX,
  requestSeriesNames,
} from './observability-request-many';

const ORG = 'org_abc123';

describe('buildRequestSeriesManyQuery', () => {
  it('org-scopes first, pins the app, counts entry spans and groups per service', () => {
    const sql = buildRequestSeriesManyQuery(ORG, { stack: 'storefront', services: ['storefront-web', 'storefront_api'] });
    const where = sql.slice(sql.indexOf('WHERE'));
    expect(where.indexOf("ResourceAttributes['swarmy.org_id'] = 'org_abc123'")).toBe(6);
    expect(sql).toContain("ResourceAttributes['swarmy.stack'] = 'storefront'");
    expect(sql).toContain("ServiceName IN ('storefront-web', 'storefront_api')");
    expect(sql).toContain("SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER')");
    expect(sql).toContain('ServiceName AS service');
    expect(sql).toContain('GROUP BY service, bucket');
    expect(sql).toContain('ORDER BY service ASC, bucket ASC');
    // The canvas default: one hour in two-minute buckets.
    expect(sql).toContain('INTERVAL 60 MINUTE');
    expect(sql).toContain('INTERVAL 120 SECOND');
  });

  it('escapes every name and the stack, and clamps the window', () => {
    const sql = buildRequestSeriesManyQuery(ORG, { stack: "s' OR 1=1", services: ["x' OR 1=1"], windowMinutes: 10 ** 9, bucketSeconds: 1 });
    expect(sql).toContain("ResourceAttributes['swarmy.stack'] = 's\\' OR 1=1'");
    expect(sql).toContain("ServiceName IN ('x\\' OR 1=1')");
    expect(sql).toContain('INTERVAL 10080 MINUTE');
    expect(sql).toContain('INTERVAL 5 SECOND');
  });

  it('an empty name list matches nothing, never every service', () => {
    const sql = buildRequestSeriesManyQuery(ORG, { stack: 'storefront', services: ['  '] });
    expect(sql).not.toContain('ServiceName IN');
    expect(sql).toMatch(/AND 0\n/);
  });
});

describe('requestSeriesNames', () => {
  it('dedupes, trims, drops blanks and caps the list', () => {
    expect(requestSeriesNames(['web', ' web ', '', 'api'])).toEqual(['web', 'api']);
    const many = Array.from({ length: REQUEST_SERIES_MANY_MAX + 10 }, (_, i) => `s${i}`);
    expect(requestSeriesNames(many)).toHaveLength(REQUEST_SERIES_MANY_MAX);
  });
});

describe('groupRequestSeries', () => {
  it('splits rows per service, ascending, with numbers parsed', () => {
    const rows = [
      { service: 'web', bucket: '2026-10-24 10:02:00', calls: '4' as unknown as number, errors: 0, p95_ms: 12 },
      { service: 'api', bucket: '2026-10-24 10:00:00', calls: 7, errors: 1, p95_ms: '30.5' as unknown as number },
      { service: 'web', bucket: '2026-10-24 10:00:00', calls: 3, errors: 0, p95_ms: 10 },
    ];
    const out = groupRequestSeries(rows);
    expect(out.map((s) => s.service)).toEqual(['web', 'api']);
    expect(out[0]!.points.map((p) => p.calls)).toEqual([3, 4]);
    expect(out[1]!.points[0]).toEqual({ bucket: '2026-10-24 10:00:00', calls: 7, errors: 1, p95_ms: 30.5 });
  });
});
