import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { completeAppLogin, resetAppAccessState, startAppLogin, verifyAppRequest, type AppAccessDeps } from './app-access.service';
import { getAppAccess } from './app-access-admin.service';
import { compactPathRule, setAppPathRules, withPathRules } from './app-access-paths.service';
import { readRoutes, type Route } from './ingress-routes';

/**
 * Per-path who-can-enter at the edge check: everyone the app admits gets
 * the app, only the `admins` group gets /admin, read the way the edge
 * reads the path; an unreadable rule set lets nobody in.
 */

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-app-access';
});

const ORG = 'org_pr';
const HOST = 'shop.acme.dev';
const RULES = [{ path: '/admin/*', groups: ['admins'] }];
let paths: unknown = RULES;

function app(): SwarmServiceInfo {
  return {
    id: 'id_shop_web',
    name: 'shop_web',
    labels: {
      'com.docker.stack.namespace': 'shop',
      'swarmy.ingress.routes': JSON.stringify([{ host: HOST, port: 3000, tls: 'auto', access: { login: true, paths } }]),
    },
    image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0, networks: [], env: [], ports: [], secrets: [], configs: [],
  } as unknown as SwarmServiceInfo;
}

let t: TestDb;
let deps: AppAccessDeps;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  await db.organization.create({ data: { id: ORG, name: 'Acme', slug: 'acme-pr', createdAt: new Date() } });
  await db.policy.create({ data: { orgId: ORG, name: 'all', effect: 'permit', priority: 30, enabled: true, source: JSON.stringify({ actions: ['app.access'] }) } });
  for (const [uid, groups] of [['u_eng', ['eng']], ['u_ops', ['admins']]] as const) {
    await db.user.create({ data: { id: uid, name: uid, email: `${uid}@acme.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await db.member.create({ data: { id: `m_${uid}`, organizationId: ORG, userId: uid, role: 'member', attributes: { ssoGroups: groups }, createdAt: new Date() } });
    await db.session.create({ data: { id: `s_${uid}`, userId: uid, token: `tok_${uid}`, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(), updatedAt: new Date() } });
  }
  deps = { db, hub: { liveInventory: () => ({ services: [app()], containers: [] }) }, publicUrl: 'https://swarmy.example.com' };
});
afterAll(async () => t?.close());
beforeEach(() => {
  resetAppAccessState();
  paths = RULES;
});

function edge(uri: string, cookie?: string): Headers {
  const h: Record<string, string> = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-forwarded-method': 'GET', accept: 'text/html', 'x-swarmy-original-uri': uri };
  if (cookie) h.cookie = cookie;
  return new Headers(h);
}

async function cookieFor(uid: string): Promise<string> {
  const start = await startAppLogin(deps, { id: `s_${uid}`, userId: uid }, `https://${HOST}/`);
  const code = new URL(String(start.headers.location)).searchParams.get('code') ?? undefined;
  return String((await completeAppLogin(deps, edge('/'), code)).headers['set-cookie']).split(';')[0]!;
}

describe('path rules at the edge check', () => {
  it('admits the app to everyone it lets in, /admin only to the group, however the path is spelled', async () => {
    const eng = await cookieFor('u_eng');
    const ops = await cookieFor('u_ops');
    for (const uri of ['/', '/orders?x=1', '/administrator']) expect((await verifyAppRequest(deps, ORG, edge(uri, eng))).status).toBe(200);
    for (const uri of ['/admin', '/admin/users', '/ADMIN', '//admin', '/x/%2e%2e/admin', '/x/../admin', '/%61dmin/', '/admin;x=1']) {
      // twice: the second answer comes from the decision cache and must still apply the rule
      expect((await verifyAppRequest(deps, ORG, edge(uri, eng))).status).toBe(403);
      expect((await verifyAppRequest(deps, ORG, edge(uri, eng))).status).toBe(403);
      expect((await verifyAppRequest(deps, ORG, edge(uri, ops))).status).toBe(200);
    }
    const row = await t.db.auditLog.findFirst({ where: { orgId: ORG, action: 'authz.deny:app.access', actorId: 'u_eng' } });
    expect(row?.metadata).toMatchObject({ reason: 'path', path: '/admin/*' });
  });

  it('signing in straight to /admin is refused for the wrong group', async () => {
    expect((await startAppLogin(deps, { id: 's_u_eng', userId: 'u_eng' }, `https://${HOST}/Admin/x`)).status).toBe(403);
    expect((await startAppLogin(deps, { id: 's_u_ops', userId: 'u_ops' }, `https://${HOST}/admin`)).status).toBe(302);
  });

  it('fails closed: an unparseable rule set admits nobody; an unreadable path is a 400', async () => {
    const ops = await cookieFor('u_ops');
    expect((await verifyAppRequest(deps, ORG, edge('/admin%zz', ops))).status).toBe(400);
    paths = [{ path: '/admin', group: ['admins'] }];
    resetAppAccessState();
    const res = await verifyAppRequest(deps, ORG, edge('/', ops));
    expect(res.status).toBe(403);
    expect(String(res.body)).toContain('couldn&#39;t be read');
    const v = await getAppAccess({ db: t.db, hub: deps.hub, activeOrgId: ORG, user: { id: 'u_ops' } } as unknown as OrgContext, 'shop');
    expect(v.routes[0]).toMatchObject({ pathRulesError: true, pathRules: [] });
  });

  it('the label keeps unreadable rules verbatim, so an unrelated rewrite never drops them', () => {
    paths = 'garbage';
    expect(readRoutes(app().labels)[0]?.access).toEqual({ login: true, paths: 'garbage' });
  });
});

describe('writing path rules', () => {
  it('stores a canonical, compact rule', () => {
    expect(compactPathRule({ path: '/Admin', groups: ['b', 'a', 'a', ' '], everyone: false, people: [] })).toEqual({ path: '/admin/*', groups: ['a', 'b'] });
    expect(compactPathRule({ path: '/*', everyone: true })).toEqual({ path: '/', everyone: true });
  });

  it('rewrites only the target route, keeping the rest of it', () => {
    const a: Route = { host: HOST, port: 80, tls: 'auto', access: { login: true, paths: RULES }, rum: 'on' };
    const b: Route = { host: 'api.acme.dev', port: 81, tls: 'auto' };
    expect(withPathRules([a, b], a, [])).toEqual([{ host: HOST, port: 80, tls: 'auto', access: { login: true }, rum: 'on' }, b]);
    expect(withPathRules([a, b], a, [{ path: '/ops/*', roles: ['owner'] }])[0]?.access).toEqual({ login: true, paths: [{ path: '/ops/*', roles: ['owner'] }] });
  });

  it('refuses rules on an address that does not ask people to sign in, and bad paths', async () => {
    const ctx = { db: t.db, hub: deps.hub, activeOrgId: ORG, user: { id: 'u_ops' } } as unknown as OrgContext;
    const id = `id_shop_web|${HOST}|`;
    await expect(setAppPathRules(ctx, { stack: 'shop', routeId: 'nope', rules: [] })).rejects.toThrow(/not found/);
    await expect(setAppPathRules(ctx, { stack: 'shop', routeId: id, rules: [{ path: '/a/../b' }] })).rejects.toThrow(/own path/);
    await expect(setAppPathRules(ctx, { stack: 'shop', routeId: id, rules: [{ path: '/a' }, { path: '/A/*' }] })).rejects.toThrow(/own path/);
  });
});
