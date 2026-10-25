import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { completeAppLogin, resetAppAccessState, startAppLogin, verifyAppRequest, type AppAccessDeps } from './app-access.service';

/**
 * App access runs the dashboard's account walls for the APP's org, not the
 * session's active one: an SSO-only org's apps refuse a password session that
 * landed in another org, and a 2FA-required org's apps refuse an unenrolled
 * member past grace.
 */

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-app-access';
});

const ORG = 'org_sso';
const OTHER = 'org_other';
const HOST = 'app.acme.dev';
const MONTH_AGO = new Date(Date.now() - 30 * 86_400_000);

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

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  for (const id of [ORG, OTHER]) await db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  await db.ssoProvider.create({ data: { orgId: ORG, protocol: 'oidc', providerId: 'acme-okta' } });
  const future = new Date(Date.now() + 86_400_000);
  for (const [uid, method, active] of [
    ['u_pw', 'password', OTHER],
    ['u_sso', 'sso:acme-okta', ORG],
  ] as const) {
    await db.user.create({ data: { id: uid, name: uid, email: `${uid}@acme.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    for (const org of [ORG, OTHER]) {
      await db.member.create({ data: { id: `m_${uid}_${org}`, organizationId: org, userId: uid, role: 'admin', createdAt: MONTH_AGO } });
    }
    await db.session.create({
      data: { id: `s_${uid}`, userId: uid, token: `tok_${uid}`, expiresAt: future, signInMethod: method, activeOrganizationId: active, createdAt: new Date(), updatedAt: new Date() },
    });
  }
  deps = { db, hub: { liveInventory: (orgId: string) => ({ services: orgId === ORG ? [APP] : [], containers: [] }) }, publicUrl: 'https://swarmy.example.com' };
});
afterAll(async () => t?.close());
beforeEach(() => resetAppAccessState());

const policy = (data: { requireSso?: boolean; require2fa?: string; graceDays?: number; enforcedSince?: Date; trustIdpMfa?: boolean }) =>
  t.db.orgSecurityPolicy.upsert({ where: { orgId: ORG }, create: { orgId: ORG, ...data }, update: data });

const start = (uid: string) => startAppLogin(deps, { id: `s_${uid}`, userId: uid }, `https://${HOST}/`);

function edge(cookie?: string): Headers {
  const h: Record<string, string> = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-forwarded-method': 'GET', accept: 'text/html' };
  if (cookie) h.cookie = cookie;
  return new Headers(h);
}

describe('app access runs the org account walls', () => {
  it("an SSO-only org's app refuses a password session from another org; its own SSO session gets in", async () => {
    await policy({ requireSso: false });
    expect((await start('u_pw')).status).toBe(302);
    await policy({ requireSso: true });
    const refused = await start('u_pw');
    expect(refused.status).toBe(403);
    expect(String(refused.body)).toContain('SSO only');
    expect((await start('u_sso')).status).toBe(302);
  });

  it('an app cookie minted before the switch stops working on the next uncached check', async () => {
    await policy({ requireSso: false });
    const code = new URL(String((await start('u_pw')).headers.location)).searchParams.get('code') ?? undefined;
    const cookie = String((await completeAppLogin(deps, edge(), code)).headers['set-cookie']).split(';')[0]!;
    expect((await verifyAppRequest(deps, ORG, edge(cookie))).status).toBe(200);
    await policy({ requireSso: true });
    resetAppAccessState();
    expect((await verifyAppRequest(deps, ORG, edge(cookie))).status).toBe(403);
  });

  it("past the org's 2FA grace, an unenrolled member reaches none of its apps", async () => {
    await policy({ requireSso: false, require2fa: 'all', graceDays: 0, enforcedSince: MONTH_AGO, trustIdpMfa: false });
    const refused = await start('u_pw');
    expect(refused.status).toBe(403);
    expect(String(refused.body)).toContain('two-factor');
    await policy({ require2fa: 'off' });
    expect((await start('u_pw')).status).toBe(302);
  });
});
