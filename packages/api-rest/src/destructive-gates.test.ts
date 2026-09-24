import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from './app';

/**
 * REST twin of trpc's destructive-gates gate: destructive routes run the same
 * `authorize` step as `abacProcedure` (via `requireAction`), so an API key —
 * which acts as its creator's CURRENT role — can't do over REST what the
 * dashboard refuses. Seeded defaults: owners/admins permitted, members refused
 * the destructive actions (and audited), members keep drain/scale/restart.
 */

type Role = 'owner' | 'admin' | 'member';

function appFor(role: Role, audit: string[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      node: { findFirst: async () => null },
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
    { liveInventory: () => ({ services: [], containers: [] }), nodeInfoFor: () => undefined },
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

const ROUTES: Array<[method: string, path: string, action: string, body?: unknown]> = [
  ['DELETE', '/services/svc', 'service.remove'],
  ['POST', '/services/svc/scale', 'service.scale', { replicas: 0 }],
  ['POST', '/services/svc/restart', 'service.restart'],
  ['DELETE', '/stacks/st1', 'stack.remove'],
  ['POST', '/nodes/n1/drain', 'node.drain'],
  ['POST', '/nodes/n1/cordon', 'node.drain'],
  ['DELETE', '/nodes/n1', 'node.remove'],
  ['DELETE', '/backup-targets/t1', 'backup.remove'],
  ['DELETE', '/api-keys/k2', 'token.revoke'],
  ['DELETE', '/mesh/routes/r1', 'token.revoke'],
  ['DELETE', '/ingress/domains/d1', 'ingress.write'],
  ['DELETE', '/dns/zones/z1', 'dns.remove'],
  ['DELETE', '/dns/records/r1', 'dns.remove'],
  ['DELETE', '/volumes/v1', 'data.destroy'],
];
const MEMBER_KEEPS = new Set(['service.scale', 'service.restart', 'node.drain', 'ingress.write']);

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

describe('REST destructive routes run the policy step (requireAction)', () => {
  for (const [method, path, action, body] of ROUTES) {
    it(`${method} ${path} → ${action}: admin/owner permitted`, async () => {
      for (const role of ['owner', 'admin'] as const) {
        const r = await hit(role, method, path, body);
        expect(r.audit).toContain(`authz.permit:${action}`);
        expect(r.code).not.toBe('POLICY_DENIED');
      }
    });
    it(`${method} ${path} → ${action}: member ${MEMBER_KEEPS.has(action) ? 'keeps it' : 'refused 403'}`, async () => {
      const r = await hit('member', method, path, body);
      if (MEMBER_KEEPS.has(action)) {
        expect(r.audit).toContain(`authz.permit:${action}`);
      } else {
        expect(r.status).toBe(403);
        expect(r.code).toBe('POLICY_DENIED');
        expect(r.audit).toEqual([`authz.deny:${action}`]);
      }
    });
  }
});
