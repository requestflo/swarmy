import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { resetAppAccessState, startAppLogin, type AppAccessDeps } from './app-access.service';
import { getAppAccess } from './app-access-admin.service';
import { setAppSignIn, withSignIn } from './app-access-signin.service';

/**
 * "Only our SSO" on a protected app: a session must have signed in with the
 * app's org's own enabled SSO provider. A password session, another org's
 * IdP, a disabled provider and an unreadable setting are all refused.
 */

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-app-access';
});

const ORG = 'org_si_sso';
const OTHER = 'org_si_sso_other';
const HOST = 'app.acme.dev';
let signIn: unknown = 'sso';

function app(): SwarmServiceInfo {
  return {
    id: 'id_shop_web',
    name: 'shop_web',
    labels: {
      'com.docker.stack.namespace': 'shop',
      'swarmy.ingress.routes': JSON.stringify([{ host: HOST, port: 3000, tls: 'auto', access: { login: true, signIn } }]),
    },
    image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0, networks: [], env: [], ports: [], secrets: [], configs: [],
  } as unknown as SwarmServiceInfo;
}

let t: TestDb;
let deps: AppAccessDeps;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  for (const id of [ORG, OTHER]) await db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  await db.ssoProvider.create({ data: { orgId: ORG, protocol: 'oidc', providerId: 'acme-okta' } });
  await db.ssoProvider.create({ data: { orgId: OTHER, protocol: 'oidc', providerId: 'other-idp' } });
  await db.policy.create({ data: { orgId: ORG, name: 'all', effect: 'permit', priority: 30, enabled: true, source: JSON.stringify({ actions: ['app.access'] }) } });
  for (const [uid, method] of [['u_pw', 'password_2fa'], ['u_sso', 'sso:acme-okta'], ['u_idp', 'sso:other-idp'], ['u_old', null]] as const) {
    await db.user.create({ data: { id: uid, name: uid, email: `${uid}@acme.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await db.member.create({ data: { id: `m_${uid}`, organizationId: ORG, userId: uid, role: 'owner', createdAt: new Date() } });
    await db.session.create({ data: { id: `s_${uid}`, userId: uid, token: `tok_${uid}`, expiresAt: new Date(Date.now() + 86_400_000), signInMethod: method, createdAt: new Date(), updatedAt: new Date() } });
  }
  deps = { db, hub: { liveInventory: (o: string) => ({ services: o === ORG ? [app()] : [], containers: [] }) }, publicUrl: 'https://swarmy.example.com' };
});
afterAll(async () => t?.close());
beforeEach(() => {
  resetAppAccessState();
  signIn = 'sso';
});

const start = (uid: string) => startAppLogin(deps, { id: `s_${uid}`, userId: uid }, `https://${HOST}/`);

describe('an app that accepts only its org’s SSO', () => {
  it('lets in its own SSO sign-in and refuses every other kind, owners included', async () => {
    expect((await start('u_sso')).status).toBe(302);
    for (const uid of ['u_pw', 'u_idp', 'u_old']) {
      const res = await start(uid);
      expect(res.status).toBe(403);
      expect(String(res.body)).toContain('single sign-on');
    }
    const row = await t.db.auditLog.findFirst({ where: { orgId: ORG, action: 'authz.deny:app.access', actorId: 'u_pw' } });
    expect(row?.metadata).toMatchObject({ reason: 'sso' });
  });

  it('a disabled provider no longer counts', async () => {
    await t.db.ssoProvider.update({ where: { providerId: 'acme-okta' }, data: { enabled: false } });
    try {
      expect((await start('u_sso')).status).toBe(403);
    } finally {
      await t.db.ssoProvider.update({ where: { providerId: 'acme-okta' }, data: { enabled: true } });
    }
  });

  it('"any" (or no setting) accepts any swarmy sign-in; an unreadable setting lets nobody in', async () => {
    signIn = 'any';
    expect((await start('u_pw')).status).toBe(302);
    signIn = undefined;
    expect((await start('u_pw')).status).toBe(302);
    signIn = 'SSO';
    expect((await start('u_sso')).status).toBe(403);
  });
});

describe('setting it', () => {
  const ctx = () => ({ db: t.db, hub: deps.hub, activeOrgId: ORG, user: { id: 'u_sso' } }) as unknown as OrgContext;

  it('shows the mode per address', async () => {
    expect((await getAppAccess(ctx(), 'shop')).routes[0]?.signIn).toBe('sso');
    signIn = 'SSO';
    expect((await getAppAccess(ctx(), 'shop')).routes[0]?.signIn).toBe('unreadable');
  });

  it('refuses SSO only while no SSO provider can sign anyone in', async () => {
    await expect(setAppSignIn(ctx(), { stack: 'shop', mode: 'sso' })).rejects.toThrow(/single sign-on/);
  });

  it('writes the mode onto the access object, keeping its other rules', () => {
    const paths = [{ path: '/admin/*', groups: ['a'] }];
    expect(withSignIn({ login: true, paths }, 'sso')).toEqual({ login: true, paths, signIn: 'sso' });
    expect(withSignIn({ login: true, paths, signIn: 'sso' }, 'any')).toEqual({ login: true, paths });
  });
});
