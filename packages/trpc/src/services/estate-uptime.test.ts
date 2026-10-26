import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { edgeSlots, estateUptime, statusCheckSlots } from './estate-uptime';

/**
 * Estate uptime over real stores: status-page samples in control.db (a minute
 * is down when any component was DOWN) and edge rollups in telemetry.db (a
 * covered bucket is down when a routed app mostly failed), org-scoped.
 */
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const MIN = 60_000;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  for (const id of ['org', 'other']) await t.db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  for (const orgId of ['org', 'other']) await t.db.statusPage.create({ data: { id: `p-${orgId}`, orgId, slug: `s-${orgId}`, title: 't' } });
});
afterEach(async () => {
  await t.close();
});

const ctx = (orgId = 'org'): OrgContext => ({ activeOrgId: orgId, db: t.db, telemetry: t.telemetry }) as unknown as OrgContext;
const since = new Date(NOW - 30 * 24 * 60 * MIN);

async function sample(orgId: string, minutesAgo: number, componentKey: string, status: 'UP' | 'DEGRADED' | 'DOWN') {
  await t.db.uptimeSample.create({ data: { orgId, pageId: `p-${orgId}`, componentKey, status, at: new Date(NOW - minutesAgo * MIN) } });
}

async function rollup(orgId: string, bucketsAgo: number, host: string, app: string | null, requests: number, errors5xx: number, nodeId = 'edge-1') {
  await t.telemetry.edgeTrafficRollup.create({
    data: { orgId, nodeId, host, app, requests, errors5xx, bucketStart: new Date(NOW - bucketsAgo * 5 * MIN) },
  });
}

describe('statusCheckSlots', () => {
  it('counts one slot per minute and a minute as down when any component was down', async () => {
    await sample('org', 3, 'api', 'UP');
    await sample('org', 3, 'db', 'DOWN');
    await sample('org', 2, 'api', 'DEGRADED');
    await sample('org', 1, 'api', 'UP');
    await sample('org', 31 * 24 * 60, 'api', 'DOWN'); // outside the window
    await sample('other', 1, 'api', 'DOWN'); // another org
    expect(await statusCheckSlots(ctx(), since)).toEqual({ slots: 3, downSlots: 1, slotMinutes: 1 });
  });
});

describe('edgeSlots', () => {
  it('counts covered buckets and the ones where a routed app mostly failed (over every edge)', async () => {
    for (const b of [1, 2, 3]) await rollup('org', b, '', null, 100, 0);
    await rollup('org', 1, 'shop.dev', 'shop', 10, 6); // down: 60% 5xx
    await rollup('org', 2, 'shop.dev', 'shop', 10, 2); // 20%: answered
    await rollup('org', 3, 'shop.dev', 'shop', 3, 3); // too few requests to judge
    await rollup('org', 2, 'shop.dev', 'shop', 10, 10, 'edge-2'); // with edge-1's: 12 of 20 failed → down
    await rollup('org', 1, 'raw.dev', null, 50, 50); // not a routed app
    await rollup('other', 1, '', null, 10, 0);
    expect(await edgeSlots(ctx(), since)).toEqual({ slots: 3, downSlots: 2, slotMinutes: 5 });
  });
});

describe('estateUptime', () => {
  it('says not enough data (never 100%) for a new estate', async () => {
    await sample('org', 1, 'api', 'UP');
    const v = await estateUptime(ctx(), NOW);
    expect(v.state).toBe('not-enough-data');
    expect(v.pct).toBeNull();
    expect(v.source).toBe('status-checks');
  });

  it('reads the edges when status checks have no history', async () => {
    for (let b = 1; b <= 300; b++) await rollup('org', b, '', null, 100, 0);
    await rollup('org', 5, 'shop.dev', 'shop', 10, 9);
    const v = await estateUptime(ctx(), NOW);
    expect(v).toMatchObject({ state: 'ok', source: 'edge-requests', pct: 99.66, downMinutes: 5, coveredHours: 25 });
  });
});
