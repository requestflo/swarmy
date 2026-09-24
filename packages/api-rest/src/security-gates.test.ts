import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from './app';

/**
 * REST twin of trpc's security-gates: ingress domain routes and node label /
 * uncordon routes resolve their resource (the target service's / node's live
 * labels), so a member API key is refused on PRODUCTION resources — the same
 * `authorize` step and audit row as the dashboard.
 */

type Role = 'owner' | 'admin' | 'member';

const ROUTES_LABEL = JSON.stringify([{ host: 'shop.example.com', port: 80, tls: 'auto' }]);
const LIVE = [
  {
    id: 'shop_web', name: 'shop_web', image: 'x', mode: 'replicated', replicas: 1, runningReplicas: 1,
    desiredReplicas: 1, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.env': 'production', 'swarmy.ingress.routes': ROUTES_LABEL },
  },
];

function appFor(role: Role, audit: string[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      node: { findFirst: async () => ({ id: 'n1', orgId: 'org1' }) },
      stack: { findFirst: async () => null },
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
      liveInventory: () => ({ services: LIVE, containers: [] }),
      nodeInfoFor: () => ({ labels: { 'swarmy.env': 'production' } }),
    },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['write'] } }),
  });
}

const DOMAIN = encodeURIComponent('shop_web:shop.example.com');
const ROUTES: Array<[method: string, path: string, action: string, body?: unknown]> = [
  ['POST', '/ingress/domains', 'ingress.write', { host: 'a.example.com', service_id: 'shop_web', target_port: 80 }],
  ['DELETE', `/ingress/domains/${DOMAIN}`, 'ingress.write'],
  ['POST', `/ingress/domains/${DOMAIN}/verify`, 'ingress.write'],
  ['PATCH', `/ingress/domains/${DOMAIN}`, 'ingress.write', { www: null }],
  ['PUT', '/nodes/n1/labels', 'node.setLabels', { labels: {} }],
  ['POST', '/nodes/n1/uncordon', 'node.drain'],
];

async function hit(role: Role, method: string, path: string, body?: unknown) {
  const audit: string[] = [];
  const res = await appFor(role, audit).request(path, {
    method,
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { swarmy_code?: string };
  return { status: res.status, code: json.swarmy_code, audit };
}

describe('REST ingress + node routes resolve production resources (requireAction)', () => {
  for (const [method, path, action, body] of ROUTES) {
    it(`${method} ${path} → ${action}: admin/owner permitted`, async () => {
      for (const role of ['owner', 'admin'] as const) {
        const r = await hit(role, method, path, body);
        expect(r.audit).toContain(`authz.permit:${action}`);
        expect(r.code).not.toBe('POLICY_DENIED');
      }
    });
    it(`${method} ${path} → ${action}: member refused 403 on production`, async () => {
      const r = await hit('member', method, path, body);
      expect(r.status).toBe(403);
      expect(r.code).toBe('POLICY_DENIED');
      expect(r.audit).toEqual([`authz.deny:${action}`]);
    });
  }
});
