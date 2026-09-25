import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { appRouter } from '../root';
import type { OrgContext } from '../context';

/** The "Show me" depth default is saved per person, server-side. */
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  for (const id of ['u_a', 'u_b']) {
    await t.db.user.create({ data: { id, name: id, email: `${id}@a.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
  }
});
afterAll(async () => {
  await t?.close();
});

const caller = (userId: string) =>
  appRouter.createCaller({
    db: t.db,
    hub: {},
    session: { id: `s_${userId}`, token: `t_${userId}` },
    user: { id: userId, email: `${userId}@a.dev`, name: userId },
    activeOrgId: null,
    reqHeaders: new Headers(),
  } as unknown as OrgContext);

describe('org.myPreferences', () => {
  it('is unset until the person picks a depth', async () => {
    expect(await caller('u_a').org.myPreferences()).toEqual({ depth: null });
  });

  it('saves and overwrites the depth, per person', async () => {
    await caller('u_a').org.setMyPreferences({ depth: 'controls' });
    await caller('u_a').org.setMyPreferences({ depth: 'code' });
    expect(await caller('u_a').org.myPreferences()).toEqual({ depth: 'code' });
    expect(await caller('u_b').org.myPreferences()).toEqual({ depth: null });
  });

  it('refuses anything but the three depths', async () => {
    await expect(caller('u_a').org.setMyPreferences({ depth: 'expert' as never })).rejects.toThrow();
  });
});
