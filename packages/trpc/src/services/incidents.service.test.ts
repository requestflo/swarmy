import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { postUpdate, publicIncidents, toPublicTimeline, toPublicUpdates } from './incidents.service';

const ORG = 'org_a';
const OTHER = 'org_b';

let t: TestDb;
let ctx: OrgContext;

function ctxFor(orgId: string): OrgContext {
  return {
    db: t.db,
    hub: {},
    activeOrgId: orgId,
    user: { id: 'u_1', name: 'Calum', email: 'calum@a.dev' },
    session: { id: 's' },
    membership: { role: 'owner', orgId },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

async function openIncident(orgId: string, title: string): Promise<string> {
  const row = await t.db.incident.create({ data: { orgId, title, severity: 'major' } });
  return row.id;
}

beforeAll(async () => {
  t = await createTestDb();
  for (const id of [ORG, OTHER]) {
    await t.db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  }
  await t.db.user.create({ data: { id: 'u_1', name: 'Calum', email: 'calum@a.dev', emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
  ctx = ctxFor(ORG);
});
afterAll(async () => t?.close());

describe('incidents.postUpdate — public status-page updates', () => {
  it('writes a status.<phase> event marked public, audited, and leaves the incident open', async () => {
    const id = await openIncident(ORG, 'Checkout errors');
    const detail = await postUpdate(ctx, { incidentId: id, phase: 'investigating', message: 'We are on it.' });
    expect(detail.status).toBe('open');
    const event = detail.events.find((e) => e.kind === 'status.investigating');
    expect(event?.message).toBe('We are on it.');
    expect(event?.meta).toMatchObject({ public: true, phase: 'investigating' });
    const audit = await t.db.auditLog.findFirst({ where: { orgId: ORG, action: 'incidents.postUpdate', targetId: id } });
    expect(audit?.metadata).toMatchObject({ phase: 'investigating' });
  });

  it('phase resolved also resolves the incident through the resolve path', async () => {
    const id = await openIncident(ORG, 'Slow API');
    const detail = await postUpdate(ctx, { incidentId: id, phase: 'resolved', message: 'Fixed and watching.' });
    expect(detail.status).toBe('resolved');
    expect(detail.resolvedAt).not.toBeNull();
    expect(detail.events.map((e) => e.kind)).toEqual(['status.resolved', 'resolved']);
    const actions = (await t.db.auditLog.findMany({ where: { orgId: ORG, targetId: id } })).map((a) => a.action).sort();
    expect(actions).toEqual(['incidents.postUpdate', 'incidents.resolve']);
  });

  it('refuses a resolved incident', async () => {
    const id = await openIncident(ORG, 'Old one');
    await postUpdate(ctx, { incidentId: id, phase: 'resolved', message: 'Done.' });
    await expect(postUpdate(ctx, { incidentId: id, phase: 'monitoring', message: 'Again?' })).rejects.toThrow(/resolved/);
  });

  it("is org-scoped: another org's incident is NOT_FOUND and gets no event", async () => {
    const theirs = await openIncident(OTHER, 'Not yours');
    await expect(postUpdate(ctx, { incidentId: theirs, phase: 'identified', message: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await t.db.incidentEvent.count({ where: { incidentId: theirs } })).toBe(0);
  });
});

describe('publicIncidents — only posted public updates reach visitors', () => {
  it('lists public updates newest first and drops notes / automation / non-public status events', async () => {
    const id = await openIncident(ORG, 'Payments timing out');
    const base = Date.now() - 3_600_000;
    const at = (m: number): Date => new Date(base + m * 60_000);
    await t.db.incidentEvent.createMany({
      data: [
        { orgId: ORG, incidentId: id, at: at(0), kind: 'opened', message: 'Incident opened', meta: {} },
        { orgId: ORG, incidentId: id, at: at(1), kind: 'note', message: 'internal: db pool exhausted', meta: { author: 'Calum' } },
        { orgId: ORG, incidentId: id, at: at(2), kind: 'status.investigating', message: 'Some checkouts fail.', meta: { public: true, phase: 'investigating' } },
        { orgId: ORG, incidentId: id, at: at(3), kind: 'status.identified', message: 'draft', meta: { phase: 'identified' } },
        { orgId: ORG, incidentId: id, at: at(4), kind: 'status.identified', message: 'A slow query times out payments.', meta: { public: true, phase: 'identified' } },
      ],
    });
    const mine = (await publicIncidents(ctx)).find((i) => i.id === id);
    expect(mine?.publicUpdates).toEqual([
      { at: at(4).toISOString(), phase: 'identified', message: 'A slow query times out payments.' },
      { at: at(2).toISOString(), phase: 'investigating', message: 'Some checkouts fail.' },
    ]);
  });

  it('the automatic feed is opened/resolved only, in fixed words — never a note, alert text or who resolved it', async () => {
    const id = await openIncident(ORG, 'Checkout slow');
    const base = Date.now() - 1_800_000;
    const at = (m: number): Date => new Date(base + m * 60_000);
    await t.db.incidentEvent.createMany({
      data: [
        { orgId: ORG, incidentId: id, at: at(0), kind: 'opened', message: 'Incident opened (alert:service:shop_checkout)', meta: { groupKey: 'alert:service:shop_checkout' } },
        { orgId: ORG, incidentId: id, at: at(1), kind: 'alert.fired', message: 'Error rate on shop_checkout is 9% (41/450 spans)', meta: {} },
        { orgId: ORG, incidentId: id, at: at(2), kind: 'note', message: 'internal: rotated the db password', meta: { author: 'Calum' } },
        { orgId: ORG, incidentId: id, at: at(3), kind: 'status.identified', message: 'draft wording', meta: { phase: 'identified' } },
        { orgId: ORG, incidentId: id, at: at(4), kind: 'resolved', message: 'Manually resolved by Calum MacRae', meta: { manual: true } },
      ],
    });
    const mine = (await publicIncidents(ctx)).find((i) => i.id === id);
    expect(mine?.updates).toEqual([
      { at: at(4).toISOString(), kind: 'resolved', message: 'This incident has been resolved.' },
      { at: at(0).toISOString(), kind: 'opened', message: 'We’re looking into an issue.' },
    ]);
    expect(mine?.publicUpdates).toEqual([]);
    const text = JSON.stringify(mine);
    for (const secret of ['internal', 'Calum', 'shop_checkout', '41/450', 'draft wording']) expect(text).not.toContain(secret);
  });

  it("never includes another org's incidents", async () => {
    await openIncident(OTHER, 'Other org outage');
    expect((await publicIncidents(ctx)).some((i) => i.title === 'Other org outage')).toBe(false);
  });
});

describe('toPublicTimeline (pure)', () => {
  it('keeps only opened/resolved, latest first, and never the stored message', () => {
    const a = new Date('2026-09-26T10:00:00Z');
    const b = new Date('2026-09-26T11:00:00Z');
    expect(
      toPublicTimeline([
        { at: a, kind: 'opened' },
        { at: b, kind: 'note' },
        { at: b, kind: 'reopened' },
        { at: b, kind: 'resolved' },
      ]),
    ).toEqual([
      { at: b.toISOString(), kind: 'resolved', message: 'This incident has been resolved.' },
      { at: a.toISOString(), kind: 'opened', message: 'We’re looking into an issue.' },
    ]);
  });
});

describe('toPublicUpdates (pure)', () => {
  it('keeps only meta.public with a known phase', () => {
    const at = new Date('2026-09-26T10:00:00Z');
    expect(
      toPublicUpdates([
        { at, kind: 'status.monitoring', message: 'ok', meta: { public: true, phase: 'monitoring' } },
        { at, kind: 'status.bogus', message: 'no', meta: { public: true, phase: 'bogus' } },
        { at, kind: 'status.monitoring', message: 'no', meta: { public: 'true', phase: 'monitoring' } },
        { at, kind: 'note', message: 'no', meta: null },
      ]),
    ).toEqual([{ at: at.toISOString(), phase: 'monitoring', message: 'ok' }]);
  });
});
