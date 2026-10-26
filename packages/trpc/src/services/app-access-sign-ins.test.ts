import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { completeAppLogin, resetAppAccessState, startAppLogin, verifyAppRequest, type AppAccessDeps } from './app-access.service';
import { recentAppSignIns, signInMethodLabel } from './app-access-sign-ins';

/**
 * Recent sign-ins: one audit row per completed sign-in (never per request),
 * throttled refusals beside them, read back org-scoped and newest first.
 */

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-app-access';
});

const ORG = 'org_si';
const OTHER = 'org_si_other';
const HOST = 'shop.acme.dev';

const APP = {
  id: 'id_shop_web',
  name: 'shop_web',
  image: 'web:1',
  mode: 'replicated',
  desiredReplicas: 1,
  runningReplicas: 1,
  createdAt: 0,
  updatedAt: 0,
  labels: {
    'com.docker.stack.namespace': 'shop',
    'swarmy.ingress.routes': JSON.stringify([{ host: HOST, port: 3000, tls: 'auto', access: { login: true } }]),
  },
  networks: [],
  env: [],
  ports: [],
  secrets: [],
  configs: [],
} as unknown as SwarmServiceInfo;

let t: TestDb;
let deps: AppAccessDeps;
const ctx = (orgId: string) => ({ db: t.db, activeOrgId: orgId, hub: deps.hub }) as unknown as OrgContext;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  for (const id of [ORG, OTHER]) await db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  await db.ssoProvider.create({ data: { orgId: ORG, protocol: 'oidc', providerId: 'acme-okta', metadata: { displayName: 'Okta' } } });
  const future = new Date(Date.now() + 86_400_000);
  for (const [uid, role, method] of [
    ['u_admin', 'admin', 'sso:acme-okta'],
    ['u_sales', 'member', 'password'],
  ] as const) {
    await db.user.create({ data: { id: uid, name: uid, email: `${uid}@acme.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await db.member.create({ data: { id: `m_${uid}`, organizationId: ORG, userId: uid, role, createdAt: new Date() } });
    await db.session.create({
      data: { id: `s_${uid}`, userId: uid, token: `tok_${uid}`, expiresAt: future, signInMethod: method, createdAt: new Date(), updatedAt: new Date() },
    });
  }
  deps = { db, hub: { liveInventory: (orgId: string) => ({ services: orgId === OTHER ? [] : [APP], containers: [] }) }, publicUrl: 'https://swarmy.example.com' };
});
afterAll(async () => t?.close());
beforeEach(() => resetAppAccessState());

function edge(cookie?: string): Headers {
  const h: Record<string, string> = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-forwarded-method': 'GET', accept: 'text/html' };
  if (cookie) h.cookie = cookie;
  return new Headers(h);
}

async function signIn(uid: string): Promise<string> {
  const start = await startAppLogin(deps, { id: `s_${uid}`, userId: uid }, `https://${HOST}/orders?id=7`);
  const code = new URL(String(start.headers.location)).searchParams.get('code') ?? undefined;
  return String((await completeAppLogin(deps, edge(), code)).headers['set-cookie']).split(';')[0]!;
}

describe('recent sign-ins', () => {
  it('records one row per sign-in, not per request, filed under the app with how they signed in', async () => {
    const cookie = await signIn('u_admin');
    for (let i = 0; i < 5; i++) {
      resetAppAccessState();
      expect((await verifyAppRequest(deps, ORG, edge(cookie))).status).toBe(200);
    }
    const rows = await t.db.auditLog.findMany({ where: { orgId: ORG, action: 'app.access.login' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'stack', targetId: 'shop', actorId: 'u_admin' });
    // The landing path is kept, its query (which may carry tokens) is not.
    expect(rows[0]!.metadata).toEqual({ host: HOST, path: '/orders', method: 'sso:acme-okta' });
  });

  it('a refused member is a throttled denied row; the list shows both, newest first, with words', async () => {
    expect((await startAppLogin(deps, { id: 's_u_sales', userId: 'u_sales' }, `https://${HOST}/`)).status).toBe(403);
    expect((await startAppLogin(deps, { id: 's_u_sales', userId: 'u_sales' }, `https://${HOST}/`)).status).toBe(403);
    const list = await recentAppSignIns(ctx(ORG), { stack: 'shop' });
    expect(list.map((r) => [r.outcome, r.email])).toEqual([
      ['denied', 'u_sales@acme.dev'],
      ['allowed', 'u_admin@acme.dev'],
    ]);
    expect(list[0]).toMatchObject({ via: null, reason: 'Not on the list of who can enter', host: HOST });
    expect(list[1]).toMatchObject({ via: 'Okta (SSO)', reason: null, path: '/orders' });
  });

  it('is org-scoped and bounded', async () => {
    await t.db.auditLog.create({ data: { orgId: OTHER, actorId: 'u_admin', action: 'app.access.login', targetType: 'stack', targetId: 'shop' } });
    expect(await recentAppSignIns(ctx(OTHER), { stack: 'shop' })).toHaveLength(1);
    expect((await recentAppSignIns(ctx(ORG), { stack: 'shop' })).every((r) => r.id !== undefined)).toBe(true);
    expect(await recentAppSignIns(ctx(ORG), { stack: 'shop', limit: 1 })).toHaveLength(1);
    expect(await recentAppSignIns(ctx(ORG), { stack: 'blog' })).toHaveLength(0);
    const ids = new Set((await recentAppSignIns(ctx(ORG), { stack: 'shop' })).map((r) => r.id));
    const otherIds = (await recentAppSignIns(ctx(OTHER), { stack: 'shop' })).map((r) => r.id);
    expect(otherIds.some((id) => ids.has(id))).toBe(false);
  });
});

describe('signInMethodLabel', () => {
  const names = new Map([['acme-okta', 'Okta']]);
  it('names the org’s SSO provider and the social / password / link kinds', () => {
    expect(signInMethodLabel('sso:acme-okta', names)).toBe('Okta (SSO)');
    expect(signInMethodLabel('sso:elsewhere', names)).toBe('elsewhere (SSO)');
    expect(signInMethodLabel('social:github', names)).toBe('GitHub');
    expect(signInMethodLabel('password_2fa', names)).toBe('Password + 2FA');
    expect(signInMethodLabel('email_link', names)).toBe('Email link');
    expect(signInMethodLabel(null, names)).toBeNull();
    expect(signInMethodLabel('bogus', names)).toBe('swarmy sign-in');
  });
});
