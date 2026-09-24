import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { getAppAccess, setAppAccessRules } from './app-access-admin.service';

const ORG = 'org_a';
let t: TestDb;
let ctx: OrgContext;

const svc = {
  id: 'svc_shop',
  name: 'shop_web',
  image: 'web:1',
  mode: 'replicated',
  runningReplicas: 1,
  createdAt: 0,
  updatedAt: 0,
  labels: {
    'com.docker.stack.namespace': 'shop',
    'swarmy.ingress.routes': JSON.stringify([{ host: 'shop.example.com', port: 80, tls: 'auto', access: { login: true } }]),
  },
  networks: [],
  env: [],
  ports: [],
  secrets: [],
  configs: [],
};

beforeAll(async () => {
  t = await createTestDb();
  await t.db.organization.create({ data: { id: ORG, name: 'A', slug: 'a', createdAt: new Date() } });
  for (const [id, role, attrs] of [
    ['u_owner', 'owner', {}],
    ['u_eng', 'member', { ssoGroups: ['eng'] }],
    ['u_ops', 'member', {}],
  ] as const) {
    await t.db.user.create({ data: { id, name: id, email: `${id}@a.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await t.db.member.create({ data: { id: `m_${id}`, organizationId: ORG, userId: id, role, attributes: attrs as object, createdAt: new Date() } });
  }
  ctx = {
    db: t.db,
    hub: { liveInventory: () => ({ services: [svc], containers: [] }) },
    activeOrgId: ORG,
    user: { id: 'u_owner' },
    session: { id: 's' },
    membership: { role: 'owner', orgId: ORG },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
});
afterAll(async () => t?.close());

const canEnter = (v: Awaited<ReturnType<typeof getAppAccess>>) =>
  v.people.filter((p) => p.canEnter).map((p) => p.memberId).sort();

describe('app Access panel', () => {
  it('lists routes with their Require-login state; only owners/admins enter by default', async () => {
    const v = await getAppAccess(ctx, 'shop');
    expect(v.routes).toEqual([
      expect.objectContaining({ host: 'shop.example.com', path: '/', requireLogin: true, endUserAuth: false }),
    ]);
    expect(canEnter(v)).toEqual(['m_u_owner']);
    expect(v.knownGroups).toEqual(['eng']);
  });

  it('a group rule admits SSO-group members; a people rule admits one person; clearing removes both', async () => {
    let v = await setAppAccessRules(ctx, { stack: 'shop', everyone: false, groups: ['eng'], people: [] });
    expect(v.rules).toEqual({ everyone: false, groups: ['eng'], people: [] });
    expect(canEnter(v)).toEqual(['m_u_eng', 'm_u_owner']);

    v = await setAppAccessRules(ctx, { stack: 'shop', everyone: false, groups: ['eng'], people: ['m_u_ops'] });
    expect(canEnter(v)).toEqual(['m_u_eng', 'm_u_ops', 'm_u_owner']);

    // the rules are scoped to THIS app's stack
    const billing = await getAppAccess(ctx, 'billing');
    expect(canEnter(billing)).toEqual(['m_u_owner']);

    v = await setAppAccessRules(ctx, { stack: 'shop', everyone: false, groups: [], people: [] });
    expect(canEnter(v)).toEqual(['m_u_owner']);
    const left = await t.db.policy.count({ where: { orgId: ORG, name: { startsWith: 'App access · shop' } } });
    expect(left).toBe(0);
  });

  it('"everyone in the org" admits every member', async () => {
    const v = await setAppAccessRules(ctx, { stack: 'shop', everyone: true, groups: [], people: [] });
    expect(canEnter(v)).toEqual(['m_u_eng', 'm_u_ops', 'm_u_owner']);
  });
});
