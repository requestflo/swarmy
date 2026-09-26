import { afterAll, describe, expect, it } from 'bun:test';
import { createTestDb } from '@swarmy/db';
import { publicStatus, type OrgContext } from '@swarmy/trpc';
import { createStatusPublicApp } from './status-public-route';

/**
 * The unauthenticated `GET /status/<slug>.json` must show visitors only what a
 * person posted plus opened/resolved — never an internal incident note, an
 * alert message, a group key or who resolved it. The real route over the real
 * status-page service on a fresh store (no gateway, no global prisma).
 */
const t = await createTestDb();
afterAll(async () => {
  await t.close();
});

const hub = { liveInventory: () => ({ services: [], nodes: [] }), nodeInventory: () => [] };
const { app } = createStatusPublicApp(async (slug) => {
  const page = await t.db.statusPage.findUnique({ where: { slug }, select: { orgId: true, enabled: true } });
  if (!page || !page.enabled) return null;
  return publicStatus({ db: t.db, hub, activeOrgId: page.orgId, user: null } as unknown as OrgContext, slug);
});

const ORG = 'org_status';
await t.db.organization.create({ data: { id: ORG, name: 'Northwind', slug: 'northwind', createdAt: new Date() } });
await t.db.statusPage.create({ data: { orgId: ORG, slug: 'northwind', title: 'Northwind status', componentsJson: [] } });
const base = Date.now() - 3_600_000;
const at = (m: number): Date => new Date(base + m * 60_000);
const incident = await t.db.incident.create({
  data: { orgId: ORG, title: 'Checkout is slow', status: 'OPEN', severity: 'critical', openedAt: at(0) },
});
await t.db.incidentEvent.createMany({
  data: [
    { orgId: ORG, incidentId: incident.id, at: at(0), kind: 'opened', message: 'Incident opened (alert:service:shop_checkout)', meta: { groupKey: 'alert:service:shop_checkout' } },
    { orgId: ORG, incidentId: incident.id, at: at(1), kind: 'alert.fired', message: 'Error rate on shop_checkout is 9% (41/450 spans)', meta: {} },
    { orgId: ORG, incidentId: incident.id, at: at(2), kind: 'note', message: 'internal: rotated the db password', meta: { author: 'Calum' } },
    { orgId: ORG, incidentId: incident.id, at: at(3), kind: 'status.identified', message: 'A slow query times out payments.', meta: { public: true, phase: 'identified' } },
    { orgId: ORG, incidentId: incident.id, at: at(4), kind: 'status.monitoring', message: 'unposted draft', meta: { phase: 'monitoring' } },
  ],
});

describe('GET /status/<slug>.json (public, unauthenticated)', () => {
  it('shows posted updates plus opened/resolved, never internal notes', async () => {
    const res = await app.request('/northwind.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: Array<Record<string, unknown>> };
    expect(body.incidents).toHaveLength(1);
    const [i] = body.incidents;
    expect(i!.publicUpdates).toEqual([
      { at: at(3).toISOString(), phase: 'identified', message: 'A slow query times out payments.' },
    ]);
    expect(i!.updates).toEqual([{ at: at(0).toISOString(), kind: 'opened', message: 'We’re looking into an issue.' }]);
    const text = JSON.stringify(body);
    for (const leak of ['internal', 'Calum', 'shop_checkout', '41/450', 'unposted draft', 'groupKey']) {
      expect(text).not.toContain(leak);
    }
  });

  it('404s an unknown slug and a malformed one', async () => {
    expect((await app.request('/nope.json')).status).toBe(404);
    expect((await app.request('/Bad_Slug.json')).status).toBe(404);
  });
});
