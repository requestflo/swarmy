import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  APP_COOKIE_PLAIN,
  APP_COOKIE_SECURE,
  appLogout,
  completeAppLogin,
  findProtectedRoute,
  resetAppAccessState,
  startAppLogin,
  verifyAppRequest,
  type AppAccessDeps,
} from './app-access.service';
import { appJwks, sealToken } from './app-access-tokens';

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-app-access';
});

const ORG = 'org_1';
const PUBLIC = 'https://swarmy.example.com';

function svc(name: string, stack: string, routes: object[], labels: Record<string, string> = {}): SwarmServiceInfo {
  return {
    id: `id_${name}`,
    name,
    image: 'web:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': stack, 'swarmy.ingress.routes': JSON.stringify(routes), ...labels },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
  } as SwarmServiceInfo;
}

const SERVICES = [
  svc('shop_web', 'shop', [{ host: 'shop.example.com', port: 3000, tls: 'auto', access: { login: true } }]),
  svc('blog_web', 'blog', [{ host: 'blog.example.com', port: 3000, tls: 'auto' }]),
];

let t: TestDb;
let deps: AppAccessDeps;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  await db.organization.create({ data: { id: ORG, name: 'Acme', slug: 'acme', createdAt: new Date() } });
  const future = new Date(Date.now() + 86_400_000);
  for (const [id, role, attrs] of [
    ['u_admin', 'admin', {}],
    ['u_eng', 'member', { ssoGroups: ['eng'] }],
    ['u_sales', 'member', {}],
  ] as const) {
    await db.user.create({ data: { id, name: id, email: `${id}@acme.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await db.member.create({ data: { id: `m_${id}`, organizationId: ORG, userId: id, role, attributes: attrs as object, createdAt: new Date() } });
    await db.session.create({ data: { id: `s_${id}`, userId: id, token: `tok_${id}`, expiresAt: future, createdAt: new Date(), updatedAt: new Date() } });
  }
  deps = { db, hub: { liveInventory: (orgId: string) => ({ services: orgId === ORG ? SERVICES : [], containers: [] }) }, publicUrl: PUBLIC };
});
afterAll(async () => t?.close());
beforeEach(() => resetAppAccessState());

function edge(host: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    host,
    'x-forwarded-host': host,
    'x-forwarded-proto': 'https',
    'x-forwarded-method': 'GET',
    accept: 'text/html,application/xhtml+xml',
    ...extra,
  });
}

/** The full login round trip for a user; returns the app cookie header value. */
async function signIn(uid: string, host = 'shop.example.com'): Promise<string> {
  const start = await startAppLogin(deps, { id: `s_${uid}`, userId: uid }, `https://${host}/orders?x=1`);
  expect(start.status).toBe(302);
  const loc = new URL(String(start.headers.location));
  expect(loc.host).toBe(host);
  expect(loc.pathname).toBe('/.swarmy/auth/callback');
  const done = await completeAppLogin(deps, edge(host), loc.searchParams.get('code') ?? undefined);
  expect(done.status).toBe(302);
  expect(done.headers.location).toBe('/orders?x=1');
  const set = String(done.headers['set-cookie']);
  expect(set).toStartWith(`${APP_COOKIE_SECURE}=`);
  expect(set).toContain('HttpOnly');
  expect(set).toContain('Secure');
  expect(set).not.toContain('Domain=');
  return set.split(';')[0]!;
}

function verifyJwt(token: string): Record<string, unknown> {
  const [h, p, s] = token.split('.') as [string, string, string];
  const key = createPublicKey({ key: appJwks().keys[0] as never, format: 'jwk' });
  expect(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(true);
  return JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
}

describe('route lookup', () => {
  it('only a route whose label carries access.login is protected', () => {
    expect(findProtectedRoute(deps.hub, ORG, 'shop.example.com')?.stack).toBe('shop');
    expect(findProtectedRoute(deps.hub, ORG, 'blog.example.com')).toBeNull();
  });
});

describe('verify (forward-auth)', () => {
  it('no cookie + a browser navigation → 302 to swarmy login, returning to the ORIGINAL uri', async () => {
    const res = await verifyAppRequest(deps, ORG, edge('shop.example.com', { 'x-swarmy-original-uri': '/api/cart?id=7', 'x-forwarded-uri': '/cart?id=7' }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${PUBLIC}/app-login?rd=${encodeURIComponent('https://shop.example.com/api/cart?id=7')}`);
  });

  it('no cookie + an API call, or nginx status mode → 401 with the login URL', async () => {
    const api = await verifyAppRequest(deps, ORG, edge('shop.example.com', { accept: 'application/json' }));
    expect(api.status).toBe(401);
    expect(String(api.headers['x-swarmy-login'])).toStartWith(`${PUBLIC}/app-login?rd=`);
    const nginx = await verifyAppRequest(deps, ORG, edge('shop.example.com', { 'x-swarmy-auth-mode': 'status' }));
    expect(nginx.status).toBe(401);
  });

  it('fails closed for a host that is not protected in this org', async () => {
    expect((await verifyAppRequest(deps, ORG, edge('blog.example.com'))).status).toBe(403);
    expect((await verifyAppRequest(deps, 'org_other', edge('shop.example.com'))).status).toBe(403);
    expect((await verifyAppRequest(deps, undefined, edge('shop.example.com'))).status).toBe(400);
  });

  it('spoofed identity headers are ignored: without a cookie a forged X-Swarmy-* still gets the login redirect', async () => {
    const res = await verifyAppRequest(
      deps,
      ORG,
      edge('shop.example.com', {
        'x-swarmy-user': 'u_admin',
        'x-swarmy-email': 'u_admin@acme.dev',
        'x-swarmy-groups': 'admins',
        'x-swarmy-jwt': 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1X2FkbWluIn0.',
        cookie: `${APP_COOKIE_SECURE}=forged.token`,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers['X-Swarmy-User']).toBeUndefined();
    // the bad cookie is cleared
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('an admin signs in and gets identity headers + a signed JWT for THIS host', async () => {
    const cookie = await signIn('u_admin');
    const res = await verifyAppRequest(deps, ORG, edge('shop.example.com', { cookie, 'x-swarmy-user': 'someone-else' }));
    expect(res.status).toBe(200);
    expect(res.headers['X-Swarmy-User']).toBe('u_admin');
    expect(res.headers['X-Swarmy-Email']).toBe('u_admin@acme.dev');
    const claims = verifyJwt(String(res.headers['X-Swarmy-Jwt']));
    expect(claims).toMatchObject({ sub: 'u_admin', aud: 'shop.example.com', iss: PUBLIC, org: ORG, stack: 'shop' });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it('a cookie for one app host is useless on another', async () => {
    const cookie = await signIn('u_admin');
    const other = await verifyAppRequest(deps, ORG, edge('evil.example.com', { cookie }));
    expect(other.status).toBe(403); // not a protected host at all
    SERVICES.push(svc('crm_web', 'crm', [{ host: 'crm.example.com', port: 80, tls: 'auto', access: { login: true } }]));
    try {
      const res = await verifyAppRequest(deps, ORG, edge('crm.example.com', { cookie }));
      expect(res.status).toBe(302);
    } finally {
      SERVICES.pop();
    }
  });

  it('a member without a rule is refused (403, audited); an SSO-group rule on the stack lets them in', async () => {
    const start = await startAppLogin(deps, { id: 's_u_eng', userId: 'u_eng' }, 'https://shop.example.com/');
    expect(start.status).toBe(403);
    const denials = await t.db.auditLog.count({ where: { orgId: ORG, action: 'authz.deny:app.access' } });
    expect(denials).toBeGreaterThan(0);

    const policy = await t.db.policy.create({
      data: {
        orgId: ORG,
        name: 'shop: eng',
        effect: 'permit',
        priority: 30,
        enabled: true,
        source: JSON.stringify({ actions: ['app.access'], resourceTypes: ['stack'], groups: ['eng'], conditions: [{ attr: 'resource.id', op: 'eq', value: 'shop' }] }),
      },
    });
    try {
      const cookie = await signIn('u_eng');
      const ok = await verifyAppRequest(deps, ORG, edge('shop.example.com', { cookie }));
      expect(ok.status).toBe(200);
      expect(ok.headers['X-Swarmy-Groups']).toBe('eng');
      // sales is still out
      expect((await startAppLogin(deps, { id: 's_u_sales', userId: 'u_sales' }, 'https://shop.example.com/')).status).toBe(403);
    } finally {
      await t.db.policy.delete({ where: { id: policy.id } });
    }
  });

  it('revoking the swarmy session ends app access (the cookie only references it)', async () => {
    const cookie = await signIn('u_admin');
    await t.db.session.update({ where: { id: 's_u_admin' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    try {
      resetAppAccessState();
      const res = await verifyAppRequest(deps, ORG, edge('shop.example.com', { cookie }));
      expect(res.status).toBe(302);
    } finally {
      await t.db.session.update({ where: { id: 's_u_admin' }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
    }
  });
});

describe('login round trip', () => {
  it('no swarmy session → the dashboard login, coming back through /app-login', async () => {
    const res = await startAppLogin(deps, null, 'https://shop.example.com/x');
    expect(res.status).toBe(302);
    expect(String(res.headers.location)).toStartWith('/login?redirect=%2Fapp-login%3Frd%3D');
  });

  it('never mints a code for a host outside the caller’s orgs (no open redirect)', async () => {
    const res = await startAppLogin(deps, { id: 's_u_admin', userId: 'u_admin' }, 'https://attacker.example.net/');
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
    expect((await startAppLogin(deps, { id: 's_u_admin', userId: 'u_admin' }, 'javascript:alert(1)')).status).toBe(400);
  });

  it('a login code is single-use, host-bound and short-lived', async () => {
    const start = await startAppLogin(deps, { id: 's_u_admin', userId: 'u_admin' }, 'https://shop.example.com/');
    const code = new URL(String(start.headers.location)).searchParams.get('code')!;
    expect((await completeAppLogin(deps, edge('crm.example.com'), code)).status).toBe(400);
    expect((await completeAppLogin(deps, edge('shop.example.com'), code)).status).toBe(302);
    expect((await completeAppLogin(deps, edge('shop.example.com'), code)).status).toBe(400);
    const stale = sealToken('code', { v: 1, sid: 's_u_admin', uid: 'u_admin', host: 'shop.example.com', org: ORG, rd: '/', nonce: 'n', exp: Math.floor(Date.now() / 1000) - 1 });
    expect((await completeAppLogin(deps, edge('shop.example.com'), stale)).status).toBe(400);
  });

  it('plain-http routes get a non-__Host- cookie; logout clears both', async () => {
    const start = await startAppLogin(deps, { id: 's_u_admin', userId: 'u_admin' }, 'http://shop.example.com:8080/');
    const loc = new URL(String(start.headers.location));
    expect(loc.origin).toBe('http://shop.example.com:8080');
    const done = await completeAppLogin(deps, edge('shop.example.com:8080', { 'x-forwarded-proto': 'http' }), loc.searchParams.get('code')!);
    const set = String(done.headers['set-cookie']);
    expect(set).toStartWith(`${APP_COOKIE_PLAIN}=`);
    expect(set).not.toContain('Secure');
    const out = appLogout(deps, edge('shop.example.com'));
    expect((out.headers['set-cookie'] as string[]).every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
});
