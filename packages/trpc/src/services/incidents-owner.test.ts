import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { getIncident, listIncidents, resolveIncidentManually } from './incidents.service';
import { releaseIncident, takeIncident } from './incidents-owner';

/**
 * "Take it for 30 min" against a real store: the hold is on the incident,
 * lapses on its own, refuses a second taker unless they take it over, and
 * every change lands on the timeline and in the audit log.
 */
let t: TestDb;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

async function setup(): Promise<{ as: (userId: string, name: string) => OrgContext; incidentId: string; orgId: string }> {
  const orgId = `org_${++seq}`;
  await t.db.organization.create({ data: { id: orgId, name: orgId, slug: orgId, createdAt: new Date() } });
  const inc = await t.db.incident.create({ data: { orgId, title: 'analytics is slow', severity: 'major' } });
  // Audit rows name their actor (a real user row, or the best-effort write drops them).
  for (const u of ['u-sam', 'u-cal']) {
    await t.db.user.create({ data: { id: `${u}-${orgId}`, name: u, email: `${u}-${orgId}@x.dev` } });
  }
  const as = (userId: string, name: string) =>
    ({ db: t.db, hub: {}, activeOrgId: orgId, user: { id: `${userId}-${orgId}`, name, email: `${userId}@x.dev` }, reqHeaders: new Headers() }) as unknown as OrgContext;
  return { as, incidentId: inc.id, orgId };
}

const kinds = async (orgId: string) => (await t.db.incidentEvent.findMany({ where: { orgId }, orderBy: { at: 'asc' } })).map((e) => e.kind);
const audits = async (orgId: string) => (await t.db.auditLog.findMany({ where: { orgId }, orderBy: { id: 'asc' } })).map((a) => a.action);

describe('takeIncident / releaseIncident', () => {
  it('takes for 30 minutes; others see who has it, the owner sees it is theirs', async () => {
    const { as, incidentId, orgId } = await setup();
    const before = Date.now();
    const d = await takeIncident(as('u-sam', 'Sam Okafor'), { id: incidentId, takeOver: false });
    expect(d.owner?.name).toBe('Sam Okafor');
    expect(d.owner?.mine).toBe(true);
    const until = Date.parse(d.owner!.until);
    expect(until - before).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(until - before).toBeLessThanOrEqual(30 * 60_000 + 1000);
    const seen = await listIncidents(as('u-cal', 'Calum'), { limit: 10 });
    expect(seen[0]?.owner).toMatchObject({ name: 'Sam Okafor', mine: false });
    expect(d.events.at(-1)?.message).toBe('Sam Okafor took this incident for 30 minutes.');
    expect(await kinds(orgId)).toEqual(['owner.taken']);
    expect(await audits(orgId)).toEqual(['incidents.take']);
  });

  it('keeps it 30 more minutes when the owner takes again', async () => {
    const { as, incidentId, orgId } = await setup();
    const first = await takeIncident(as('u-sam', 'Sam'), { id: incidentId, takeOver: false });
    const again = await takeIncident(as('u-sam', 'Sam'), { id: incidentId, takeOver: false });
    expect(Date.parse(again.owner!.until) - Date.parse(first.owner!.until)).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(await kinds(orgId)).toEqual(['owner.taken', 'owner.kept']);
    expect(await audits(orgId)).toEqual(['incidents.take', 'incidents.keep']);
  });

  it('refuses a second taker until they take it over', async () => {
    const { as, incidentId, orgId } = await setup();
    await takeIncident(as('u-sam', 'Sam'), { id: incidentId, takeOver: false });
    await expect(takeIncident(as('u-cal', 'Calum'), { id: incidentId, takeOver: false })).rejects.toThrow('Sam has this incident');
    const d = await takeIncident(as('u-cal', 'Calum'), { id: incidentId, takeOver: true });
    expect(d.owner).toMatchObject({ name: 'Calum', mine: true });
    expect(d.events.at(-1)?.message).toBe('Calum took it over from Sam.');
    expect(await kinds(orgId)).toEqual(['owner.taken', 'owner.takenOver']);
  });

  it('lapses on its own: past the deadline nobody has it and anyone may take it', async () => {
    const { as, incidentId } = await setup();
    await t.db.incident.update({ where: { id: incidentId }, data: { ownerUserId: 'u-sam', ownerName: 'Sam', ownedUntil: new Date(Date.now() - 1000) } });
    expect((await getIncident(as('u-cal', 'Calum'), { id: incidentId })).owner).toBeNull();
    const d = await takeIncident(as('u-cal', 'Calum'), { id: incidentId, takeOver: false });
    expect(d.owner?.name).toBe('Calum');
    expect(d.events.at(-1)?.kind).toBe('owner.taken');
  });

  it('only the owner lets go; afterwards nobody has it', async () => {
    const { as, incidentId, orgId } = await setup();
    await takeIncident(as('u-sam', 'Sam'), { id: incidentId, takeOver: false });
    await expect(releaseIncident(as('u-cal', 'Calum'), { id: incidentId })).rejects.toThrow('only they can let it go');
    const d = await releaseIncident(as('u-sam', 'Sam'), { id: incidentId });
    expect(d.owner).toBeNull();
    expect(d.events.at(-1)?.message).toBe('Sam let it go.');
    await expect(releaseIncident(as('u-sam', 'Sam'), { id: incidentId })).rejects.toThrow('nobody has this incident');
    expect(await audits(orgId)).toEqual(['incidents.take', 'incidents.release']);
  });

  it('a resolved incident has no owner and cannot be taken', async () => {
    const { as, incidentId } = await setup();
    await takeIncident(as('u-sam', 'Sam'), { id: incidentId, takeOver: false });
    const done = await resolveIncidentManually(as('u-sam', 'Sam'), { id: incidentId });
    expect(done.owner).toBeNull();
    await expect(takeIncident(as('u-sam', 'Sam'), { id: incidentId, takeOver: false })).rejects.toThrow('resolved');
  });

  it('never reaches across orgs', async () => {
    const a = await setup();
    const b = await setup();
    await expect(takeIncident(b.as('u-sam', 'Sam'), { id: a.incidentId, takeOver: false })).rejects.toThrow();
  });
});
