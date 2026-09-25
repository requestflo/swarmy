import { beforeAll, describe, expect, it } from 'bun:test';
import { buildMetricsSeriesQuery, buildMetricsSummaryQuery } from './observability-query';

/**
 * The metrics SQL against a REAL ClickHouse (QA-041). Opt-in: set
 * SWARMY_CLICKHOUSE_URL (e.g. http://localhost:18123/) with a throwaway server:
 *
 *   docker run -d --name swarmy-qa-ch -p 18123:8123 -e CLICKHOUSE_SKIP_USER_SETUP=1 clickhouse/clickhouse-server:24.8-alpine
 *   SWARMY_CLICKHOUSE_URL=http://localhost:18123/ bun test observability-query.clickhouse
 *   docker rm -f swarmy-qa-ch
 *
 * Tables carry the column names/types the OTel ClickHouse exporter (contrib
 * 0.111) creates for the columns the builders read.
 */
const CH = process.env.SWARMY_CLICKHOUSE_URL;
const db = `swarmy_it_${Date.now()}`;

async function q(sql: string): Promise<string> {
  const r = await fetch(`${CH}?database=${db}`, { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${t}\n${sql}`);
  return t;
}
const rows = async (sql: string) => JSON.parse(await q(`${sql}\nFORMAT JSONCompact`)).data as unknown[][];

describe.skipIf(!CH)('metrics SQL on ClickHouse', () => {
  beforeAll(async () => {
    await fetch(CH!, { method: 'POST', body: `CREATE DATABASE ${db}` });
    const common =
      'ResourceAttributes Map(LowCardinality(String), String), ServiceName LowCardinality(String), MetricName String, Attributes Map(LowCardinality(String), String), StartTimeUnix DateTime64(9), TimeUnix DateTime64(9)';
    const order = 'ENGINE = MergeTree ORDER BY (ServiceName, MetricName, toUnixTimestamp64Nano(TimeUnix))';
    await q(`CREATE TABLE otel_metrics_gauge (${common}, Value Float64, Flags UInt32) ${order}`);
    await q(`CREATE TABLE otel_metrics_sum (${common}, Value Float64, Flags UInt32, AggregationTemporality Int32, IsMonotonic Boolean) ${order}`);
    await q(`CREATE TABLE otel_metrics_histogram (${common}, Count UInt64, Sum Float64, BucketCounts Array(UInt64), ExplicitBounds Array(Float64), Min Float64, Max Float64, Flags UInt32, AggregationTemporality Int32) ${order}`);
    const ra = (org: string) => `map('swarmy.org_id','${org}','swarmy.stack','shop')`;
    await q(`INSERT INTO otel_metrics_histogram (ResourceAttributes, ServiceName, MetricName, TimeUnix, Count, Sum) VALUES
      (${ra('org1')}, 'shop_web', 'http.server.duration', now64(9) - INTERVAL 2 MINUTE, 4, 100),
      (${ra('org1')}, 'shop_web', 'http.server.duration', now64(9) - INTERVAL 1 MINUTE, 0, 0),
      (${ra('org2')}, 'other_web', 'http.server.duration', now64(9) - INTERVAL 1 MINUTE, 1, 999)`);
    await q(`INSERT INTO otel_metrics_sum (ResourceAttributes, ServiceName, MetricName, TimeUnix, Value) VALUES (${ra('org1')}, 'shop_api', 'http.requests', now64(9) - INTERVAL 1 MINUTE, 42)`);
    await q(`INSERT INTO otel_metrics_gauge (ResourceAttributes, ServiceName, MetricName, TimeUnix, Value) VALUES (${ra('org1')}, 'shop_api', 'process.memory', now64(9) - INTERVAL 1 MINUTE, 7.5)`);
  });

  it('histogram metrics (http.server.duration) come back as the mean, empty points skipped', async () => {
    expect(await rows(buildMetricsSummaryQuery('org1', { metric: 'http.server.duration', stack: 'shop' }))).toEqual([['shop_web', 25, 25, '1']]);
    const series = await rows(buildMetricsSeriesQuery('org1', { metric: 'http.server.duration', stack: 'shop' }));
    expect(series.map((r) => r[1])).toEqual([25]);
  });

  it('sum and gauge metrics are queryable too', async () => {
    expect(await rows(buildMetricsSummaryQuery('org1', { metric: 'http.requests' }))).toEqual([['shop_api', 42, 42, '1']]);
    expect(await rows(buildMetricsSummaryQuery('org1', { metric: 'process.memory' }))).toEqual([['shop_api', 7.5, 7.5, '1']]);
  });

  it('never crosses orgs', async () => {
    expect(await rows(buildMetricsSummaryQuery('org2', { metric: 'http.server.duration' }))).toEqual([['other_web', 999, 999, '1']]);
  });
});
