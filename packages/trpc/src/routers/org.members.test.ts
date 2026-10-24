import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { appRouter } from '../root';
import type { OrgContext } from '../context';

/** Members & roles: "last seen" is the newest Better Auth session's updatedAt. */
let t: TestDb;
const ORG = 'org_1';
const day = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  t = await createTestDb();
  await t.db.organization.create({ data: { id: ORG, name: 'Acme', slug: 'acme', createdAt: new Date() } });
  for (const id of ['u_a', 'u_b']) {
    await t.db.user.create({ data: { id, name: id, email: `${id}@a.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await t.db.member.create({ data: { id: `m_${id}`, organizationId: ORG, userId: id, role: 'member', createdAt: day(30) } });
  }
  const session = (id: string, userId: string, updatedAt: Date) =>
    t.db.session.create({ data: { id, userId, token: `tok_${id}`, expiresAt: new Date(Date.now() + 86_400_000), createdAt: day(10), updatedAt } });
  await session('s1', 'u_a', day(5));
  await session('s2', 'u_a', day(1));
});
afterAll(async () => {
  await t?.close();
});

describe('org.members', () => {
  it('carries lastSeenAt from the newest session, null with none on record', async () => {
    const caller = appRouter.createCaller({
      db: t.db,
      hub: {},
      session: { id: 's2', token: 'tok_s2' },
      user: { id: 'u_a', email: 'u_a@a.dev', name: 'u_a' },
      activeOrgId: ORG,
      reqHeaders: new Headers(),
    } as unknown as OrgContext);
    const rows = await caller.org.members();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const a = (await t.db.session.findUnique({ where: { id: 's2' } }))!.updatedAt.toISOString();
    expect(byId.m_u_a!.lastSeenAt).toBe(a);
    expect(byId.m_u_b!.lastSeenAt).toBeNull();
    expect('sessions' in byId.m_u_a!.user).toBe(false);
  });
});
