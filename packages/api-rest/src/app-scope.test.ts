import { describe, expect, it } from 'bun:test';
import { seedKv, useMemoryKv, type OrgContext } from '@swarmy/trpc';
import type { ApiKeyScope } from '@swarmy/core';
import { appRuleFor } from './app-scope';
import { createRestApp } from './app';

/**
 * Owner decision Q7: an API key limited to some apps reaches only those apps.
 * The gate (`appScopeGate`) runs for every route: another app answers 404, an
 * org-wide route (keys, servers, members, settings) answers 403, org-wide lists
 * are filtered. The key's scopes and its creator's role still apply on top.
 */

const svc = (id: string, stack: string) => ({
  id,
  name: `${stack}_${id}`,
  image: 'x',
  mode: 'replicated',
  replicas: 1,
  runningReplicas: 1,
  desiredReplicas: 1,
  labels: { 'com.docker.stack.namespace': stack },
  networks: [],
  env: [],
  ports: [],
  createdAt: 0,
  updatedAt: 0,
});

function appFor(key: { scopes: ApiKeyScope[]; stackNames: string[] | null }, audit: string[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role: 'admin', organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      node: { findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, orgId: 'org1' }) },
      apiKey: { findMany: async () => [] },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          audit.push(data.action);
          return {};
        },
      },
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const hub = new Proxy(
    {
      liveInventory: () => ({ services: [svc('web', 'shop'), svc('api', 'billing')], containers: [] }),
      nodeInfoFor: () => undefined,
    },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'stack', 'st-shop', { name: 'shop', composeSource: '', ingressDriver: null });
  seedKv(hub as never, 'org1', 'stack', 'st-billing', { name: 'billing', composeSource: '', ingressDriver: null });
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role: 'admin', orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', ...key } }),
  });
}

async function hit(key: { scopes: ApiKeyScope[]; stackNames: string[] | null }, method: string, path: string, body?: unknown) {
  const audit: string[] = [];
  const res = await appFor(key, audit).request(path, {
    method,
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, audit };
}

const SHOP_DEPLOY = { scopes: ['read', 'deploy'] as ApiKeyScope[], stackNames: ['shop'] };
const SHOP_ADMIN = { scopes: ['read', 'write', 'secrets.read'] as ApiKeyScope[], stackNames: ['shop'] };

describe('app-scoped API keys reach only their apps', () => {
  it('can deploy and restart its own app', async () => {
    const deploy = await hit(SHOP_DEPLOY, 'POST', '/stacks', { name: 'shop', compose_source: 'services: {}' });
    expect(deploy.audit).toContain('authz.permit:stack.deploy');
    const restart = await hit(SHOP_DEPLOY, 'POST', '/services/web/restart');
    expect(restart.audit).toContain('authz.permit:service.restart');
  });

  it("can't touch another app: 404, and the policy step never runs", async () => {
    const deploy = await hit(SHOP_DEPLOY, 'POST', '/stacks', { name: 'billing', compose_source: 'services: {}' });
    expect(deploy.status).toBe(404);
    expect(deploy.audit).toEqual([]);
    for (const [method, path] of [
      ['POST', '/services/api/restart'],
      ['GET', '/services/api'],
      ['GET', '/stacks/st-billing'],
      ['DELETE', '/stacks/st-billing'],
      ['GET', '/deployments/stack:billing'],
    ] as const) {
      const r = await hit(SHOP_ADMIN, method, path);
      expect(r.status).toBe(404);
      expect(r.audit).toEqual([]);
    }
  });

  it("can't create keys, members or touch servers and settings (403, even as Admin)", async () => {
    for (const [method, path, body] of [
      ['POST', '/api-keys', { name: 'x' }],
      ['GET', '/api-keys', undefined],
      ['DELETE', '/nodes/n1', undefined],
      ['GET', '/nodes', undefined],
      ['POST', '/services', { name: 'loose', image: 'nginx' }],
      ['POST', '/dns/zones', { name: 'x.com' }],
    ] as const) {
      const r = await hit(SHOP_ADMIN, method, path, body);
      expect(r.status).toBe(403);
      expect(r.json.swarmy_code).toBe('POLICY_DENIED');
    }
  });

  it('org-wide lists are filtered to its apps', async () => {
    const stacks = await hit(SHOP_DEPLOY, 'GET', '/stacks');
    expect(stacks.status).toBe(200);
    expect((stacks.json.data as { name: string }[]).map((s) => s.name)).toEqual(['shop']);
    const services = await hit(SHOP_DEPLOY, 'GET', '/services');
    expect((services.json.data as { stack_id: string }[]).map((s) => s.stack_id)).toEqual(['shop']);
  });

  it('a key on every app is untouched by the gate', async () => {
    const all = { scopes: ['read'] as ApiKeyScope[], stackNames: null };
    const stacks = await hit(all, 'GET', '/stacks');
    expect((stacks.json.data as { name: string }[]).map((s) => s.name).sort()).toEqual(['billing', 'shop']);
    expect((await hit(all, 'GET', '/api-keys')).status).toBe(200);
  });
});

describe('the Deploy preset ships but never administers', () => {
  const deployAll = { scopes: ['read', 'deploy'] as ApiKeyScope[], stackNames: null };
  it('deploys (scope deploy) but is refused write-scoped routes', async () => {
    const ok = await hit(deployAll, 'POST', '/stacks', { name: 'shop', compose_source: 'services: {}' });
    expect(ok.audit).toContain('authz.permit:stack.deploy');
    const node = await hit(deployAll, 'DELETE', '/nodes/n1');
    expect(node.status).toBe(403);
    expect(node.audit).toEqual([]);
    const key = await hit(deployAll, 'POST', '/api-keys', { name: 'x' });
    expect(key.status).toBe(403);
  });
  it('Read-only is refused deploys', async () => {
    const r = await hit({ scopes: ['read'], stackNames: null }, 'POST', '/stacks', { name: 'shop', compose_source: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('appRuleFor', () => {
  it('matches templated paths and decodes params; unknown routes are org-wide', () => {
    expect(appRuleFor('get', '/services/abc%2F1/logs')?.params).toEqual({ id: 'abc/1' });
    expect(appRuleFor('GET', '/nodes')).toBeNull();
    expect(appRuleFor('DELETE', '/api-keys/k1')).toBeNull();
  });
});
