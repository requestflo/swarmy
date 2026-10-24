import { beforeAll, describe, expect, it } from 'bun:test';
import { buildLogsQuery } from './observability-logs-query';

/**
 * The logs SQL (source column + prefer-OTLP dedupe) against a REAL ClickHouse.
 * Opt-in, like observability-query.clickhouse: set SWARMY_CLICKHOUSE_URL
 * (e.g. http://localhost:18123/, `?user=…&password=…` allowed) to a throwaway
 * server. Columns are the ones the OTel ClickHouse exporter (contrib 0.111)
 * creates for `otel_logs` that the builder reads.
 */
const CH = process.env.SWARMY_CLICKHOUSE_URL;
const db = `swarmy_it_logs_${Date.now()}`;

async function q(sql: string, database: string | null = db): Promise<string> {
  const url = new URL(CH!);
  if (database) url.searchParams.set('database', database);
  const r = await fetch(url, { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${t}\n${sql}`);
  return t;
}
const rows = async (sql: string) =>
  (await q(`${sql}\nFORMAT JSONEachRow`)).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const NOW = Date.now();
const window = { from: NOW - 10 * 60_000, to: NOW + 60_000 };
const line = (r: Record<string, unknown>) => `${r.service_name}|${r.source}|${r.body}`;

describe.skipIf(!CH)('logs SQL on ClickHouse', () => {
  beforeAll(async () => {
    await q(`CREATE DATABASE ${db}`, null);
    await q(`CREATE TABLE otel_logs (
      Timestamp DateTime64(9), TraceId String, SpanId String, SeverityText LowCardinality(String),
      SeverityNumber Int32, ServiceName LowCardinality(String), Body String,
      ResourceAttributes Map(LowCardinality(String), String), LogAttributes Map(LowCardinality(String), String)
    ) ENGINE = MergeTree ORDER BY (ServiceName, Timestamp)`);
    const ra = (org: string, svc: string, stdout: boolean) =>
      `map('swarmy.org_id','${org}','swarmy.stack','shop','swarmy.service','${svc}'${stdout ? ",'swarmy.log.source','stdout'" : ''})`;
    const row = (org: string, svc: string, stdout: boolean, body: string) =>
      `(now64(9) - INTERVAL 1 MINUTE, '', '', '', 9, '${svc}', '${body}', ${ra(org, svc, stdout)}, map())`;
    await q(`INSERT INTO otel_logs VALUES
      ${row('org1', 'shop_api', false, 'api via otlp')},
      ${row('org1', 'shop_api', true, 'api printed')},
      ${row('org1', 'shop_web', true, 'web printed')},
      ${row('org2', 'other_web', false, 'other org')}`);
  });

  it('auto shows a service’s stdout only when it sent no OTLP log', async () => {
    const got = (await rows(buildLogsQuery('org1', window))).map(line).sort();
    expect(got).toEqual(['shop_api|otlp|api via otlp', 'shop_web|stdout|web printed']);
  });

  it('all / stdout / otlp, and never another org', async () => {
    expect((await rows(buildLogsQuery('org1', { ...window, source: 'all' }))).length).toBe(3);
    expect((await rows(buildLogsQuery('org1', { ...window, source: 'stdout' }))).map(line).sort()).toEqual([
      'shop_api|stdout|api printed',
      'shop_web|stdout|web printed',
    ]);
    expect((await rows(buildLogsQuery('org1', { ...window, source: 'otlp' }))).map(line)).toEqual(['shop_api|otlp|api via otlp']);
    expect((await rows(buildLogsQuery('org2', { ...window, source: 'all' }))).map(line)).toEqual(['other_web|otlp|other org']);
  });
});
