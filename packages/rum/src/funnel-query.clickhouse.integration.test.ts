import { beforeAll, describe, expect, it } from 'bun:test';
import { RUM_DDL } from './clickhouse';
import { stepVisitors } from './funnel-math';
import { buildFunnelQuery, type FunnelRow } from './funnel-query';

/**
 * The funnel SQL against a REAL ClickHouse, on the real `swarmy_rum_events`
 * DDL. Opt-in like the observability builders' integration tests: set
 * SWARMY_CLICKHOUSE_URL (e.g. http://localhost:18123/?user=…&password=…) to a
 * throwaway server; it skips without one.
 */
const CH = process.env.SWARMY_CLICKHOUSE_URL;
const db = `swarmy_it_funnel_${Date.now()}`;

async function q(sql: string, database: string | null = db): Promise<string> {
  const url = new URL(CH!);
  if (database) url.searchParams.set('database', database);
  const r = await fetch(url, { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${t}\n${sql}`);
  return t;
}
const rows = async (sql: string): Promise<FunnelRow[]> =>
  (await q(`${sql}\nFORMAT JSONEachRow`)).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FunnelRow);

const STEPS = [{ path: '/cart' }, { path: '/checkout/*' }, { path: '/checkout/*', event: 'paid' }];
const NOW = Date.now();
const RELEASE_AT = NOW - 30 * 60_000;

/** One event row: minutes ago, org, kind, path, event, visitor hash, session, user. */
function ev(min: number, org: string, kind: string, path: string, event: string, vh: number, sid = '', uid = ''): string {
  const ts = new Date(NOW - min * 60_000).toISOString().replace('T', ' ').replace('Z', '');
  return `('${ts}', '${org}', 'shop', 14, '${kind}', 'shop.test', '${path}', '', '', '', '', '', 'desktop', 'Chrome', ${vh}, '${sid}', '${uid}', '${event}', 0)`;
}

describe.skipIf(!CH)('funnel SQL on ClickHouse', () => {
  beforeAll(async () => {
    await q(`CREATE DATABASE ${db}`, null);
    for (const ddl of RUM_DDL) await q(ddl);
    await q(`INSERT INTO swarmy_rum_events VALUES
      ${[
        // Before the release: a privacy-mode visit that pays (no session id).
        ev(90, 'org1', 'pv', '/cart', '', 1), ev(89, 'org1', 'pv', '/checkout/pay', '', 1), ev(88, 'org1', 'ev', '/checkout/pay', 'paid', 1),
        // Since the release: one signed-in session stops at checkout, one anonymous one at the cart.
        ev(20, 'org1', 'pv', '/cart', '', 2, 'sessaaaaaaaa', ''), ev(19, 'org1', 'pv', '/checkout/pay', '', 2, 'sessaaaaaaaa', 'u1'),
        ev(10, 'org1', 'pv', '/cart', '', 3, 'sessbbbbbbbb'),
        // Out of order: paid before the cart never counts past step 1.
        ev(9, 'org1', 'ev', '/checkout/pay', 'paid', 4), ev(8, 'org1', 'pv', '/cart', '', 4),
        // Another org's perfect funnel must never show up.
        ev(5, 'org2', 'pv', '/cart', '', 5), ev(4, 'org2', 'pv', '/checkout/x', '', 5), ev(3, 'org2', 'ev', '/checkout/x', 'paid', 5),
      ].join(',\n      ')}`);
  });

  it('counts visits at each step, in order, inside the org wall', async () => {
    const r = await rows(buildFunnelQuery('org1', 'shop', { steps: STEPS }));
    expect(stepVisitors(r, 3)).toEqual([4, 2, 1]);
  });

  it('splits by the release live when the visit began', async () => {
    const r = await rows(buildFunnelQuery('org1', 'shop', { steps: STEPS, releases: [{ id: 'rel-new', fromMs: RELEASE_AT }] }));
    expect(stepVisitors(r.filter((x) => x.release === ''), 3)).toEqual([1, 1, 1]);
    expect(stepVisitors(r.filter((x) => x.release === 'rel-new'), 3)).toEqual([3, 1, 0]);
  });

  it('signed-in people only: visits with a verified user id', async () => {
    const r = await rows(buildFunnelQuery('org1', 'shop', { steps: STEPS, signedIn: true }));
    expect(stepVisitors(r, 3)).toEqual([1, 1, 0]);
  });
});
