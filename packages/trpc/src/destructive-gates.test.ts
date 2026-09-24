import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { ACTIONS } from '@swarmy/abac';
import { appRouter } from './root';
import { authorize } from './abac';
import type { OrgContext } from './context';

/**
 * CI gate (auth-abac + testing-conventions): every destructive mutation runs
 * the fine-grained policy step (`abacProcedure` → `authorize`) — owner decision
 * 2026-09-24. With the seeded defaults an owner/admin is never locked out; a
 * member is refused the destructive actions and keeps today's safe ops. The
 * policy step runs BEFORE the resolver, so the mocks below never reach a
 * service: a permit shows up as an `authz.permit:<action>` audit row and
 * whatever the (unmocked) service then throws is irrelevant.
 */

type Role = 'owner' | 'admin' | 'member';

function ctxFor(role: Role, audit: string[]) {
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
      // Any other model the service touches after a permit: fail loudly but
      // harmlessly (the gate has already decided by then).
      get: (t, k: string) =>
        k in t
          ? t[k]
          : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const hub = new Proxy(
    { liveInventory: () => ({ services: [], containers: [] }), nodeInfoFor: () => undefined },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  return {
    db,
    hub,
    session: { id: 's1' },
    user: { id: 'user1', email: 'u@example.com', name: 'u' },
    activeOrgId: 'org1',
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

/** [procedure path, a valid-enough input, the governed action]. */
const GATES: Array<[string, unknown, string]> = [
  ['services.scale', { id: 'svc', replicas: 0 }, 'service.scale'],
  ['services.restart', { id: 'svc' }, 'service.restart'],
  ['services.remove', { id: 'svc' }, 'service.remove'],
  ['nodes.drain', { id: 'n1' }, 'node.drain'],
  ['nodes.remove', { id: 'n1' }, 'node.remove'],
  ['nodes.runHygiene', { nodeId: 'n1' }, 'data.destroy'],
  ['nodes.revokeJoinToken', { id: 't1' }, 'token.revoke'],
  ['stacks.remove', { id: 'st1' }, 'stack.remove'],
  ['previews.destroy', {}, 'stack.remove'],
  ['ingress.removeDomain', { id: 'd1' }, 'ingress.write'],
  ['ingress.tunnels.delete', undefined, 'ingress.remove'],
  ['cache.destroy', {}, 'data.destroy'],
  ['cache.restore', {}, 'data.restore'],
  ['search.destroy', {}, 'data.destroy'],
  ['search.restore', {}, 'data.restore'],
  ['vector.destroy', {}, 'data.destroy'],
  ['volumes.deregisterCluster', {}, 'data.destroy'],
  ['buckets.deleteBucket', {}, 'data.destroy'],
  ['buckets.deleteKey', {}, 'data.destroy'],
  ['storage.disable', undefined, 'data.destroy'],
  ['queues.remove', {}, 'data.destroy'],
  ['queues.drain', {}, 'data.destroy'],
  ['backups.removeTarget', {}, 'backup.remove'],
  ['backups.restoreSnapshot', {}, 'data.restore'],
  ['dbBackups.restore', {}, 'data.restore'],
  ['controllerBackup.restore', {}, 'data.restore'],
  ['offsiteMirror.remove', undefined, 'backup.remove'],
  ['offsiteMirror.restore', {}, 'data.restore'],
  ['secrets.deleteFamily', {}, 'secret.delete'],
  ['secrets.pruneVersions', {}, 'secret.delete'],
  ['configs.deleteFamily', {}, 'secret.delete'],
  ['configs.pruneVersions', {}, 'secret.delete'],
  ['geodns.removeZone', {}, 'dns.remove'],
  ['geodns.removeRecord', {}, 'dns.remove'],
  ['apiKeys.revoke', { id: 'k1' }, 'token.revoke'],
  ['oauth.revoke', { id: 'c1' }, 'token.revoke'],
  ['mesh.routes.revoke', { routeId: 'r1' }, 'token.revoke'],
  ['members.deleteGrant', {}, 'member.write'],
  ['members.revokeInvitation', {}, 'member.write'],
  ['policies.delete', { id: 'p1' }, 'policy.write'],
  ['sso.delete', { id: 'sso1' }, 'authconfig.write'],
  ['cicd.removeRepo', { id: 'r1' }, 'cicd.remove'],
  ['security.policy.set', { require2fa: 'admins' }, 'authconfig.write'],
  ['security.resetMember', { memberId: 'm' }, 'member.write'],
  ['gitConnections.remove', { id: 'g1' }, 'cicd.remove'],
  ['registryCredentials.remove', { id: 'rc1' }, 'secret.delete'],
  ['db.confirmFailover', {}, 'data.failover'],
];

/** Member-allowed today (orgProcedure before the sweep) — must stay allowed. */
const MEMBER_KEEPS = new Set(['service.scale', 'service.restart', 'node.drain', 'ingress.write']);

async function call(role: Role, path: string, input: unknown): Promise<{ audit: string[]; error: unknown }> {
  const audit: string[] = [];
  const caller = appRouter.createCaller(ctxFor(role, audit) as never) as unknown as Record<string, unknown>;
  const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], caller);
  if (typeof fn !== 'function') throw new Error(`no procedure ${path}`);
  let error: unknown = null;
  try {
    await (fn as (i: unknown) => Promise<unknown>)(input);
  } catch (e) {
    error = e;
  }
  return { audit, error };
}

const isPolicyDenied = (e: unknown) =>
  e instanceof TRPCError &&
  e.code === 'FORBIDDEN' &&
  (e.cause as { swarmyCode?: string } | undefined)?.swarmyCode === 'POLICY_DENIED';

describe('destructive mutations sit behind abacProcedure (seeded defaults)', () => {
  it('every gated action is a real ACTIONS member', () => {
    for (const [, , action] of GATES) expect((ACTIONS as readonly string[]).includes(action)).toBe(true);
  });

  for (const [path, input, action] of GATES) {
    it(`${path} → ${action}: owner + admin permitted (no lockout)`, async () => {
      for (const role of ['owner', 'admin'] as const) {
        const { audit, error } = await call(role, path, input);
        expect(audit).toContain(`authz.permit:${action}`);
        expect(isPolicyDenied(error)).toBe(false);
      }
    });

    const memberKeeps = MEMBER_KEEPS.has(action);
    it(`${path} → ${action}: member ${memberKeeps ? 'keeps it' : 'is refused (audited)'}`, async () => {
      const { audit, error } = await call('member', path, input);
      if (memberKeeps) {
        expect(audit).toContain(`authz.permit:${action}`);
        expect(isPolicyDenied(error)).toBe(false);
      } else {
        expect(isPolicyDenied(error)).toBe(true);
        expect(audit).toEqual([`authz.deny:${action}`]);
      }
    });
  }
});

describe('authorize — the step both front doors share', () => {
  it('permits + audits one permit row', async () => {
    const audit: string[] = [];
    const ctx = { ...ctxFor('admin', audit), membership: { role: 'admin', orgId: 'org1' } } as unknown as OrgContext;
    const r = await authorize(ctx, 'data.destroy', null);
    expect(r).toEqual({ action: 'data.destroy', decision: 'permit', policyId: 'default:admin-superuser' });
    expect(audit).toEqual(['authz.permit:data.destroy']);
  });

  it('denies with POLICY_DENIED + one deny row', async () => {
    const audit: string[] = [];
    const ctx = { ...ctxFor('member', audit), membership: { role: 'member', orgId: 'org1' } } as unknown as OrgContext;
    const e = await authorize(ctx, 'data.failover', null).catch((x) => x);
    expect(isPolicyDenied(e)).toBe(true);
    expect(audit).toEqual(['authz.deny:data.failover']);
  });
});

describe('resource-scoped policies reach the router gate (raw input → resolver)', () => {
  it('a label policy lets a member remove a staging service, not a prod one', async () => {
    const svc = (id: string, env: string) => ({
      id, name: id, image: 'x', mode: 'replicated', replicas: 1, runningReplicas: 1, desiredReplicas: 1,
      labels: { env }, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
    });
    const run = async (id: string) => {
      const audit: string[] = [];
      const base = ctxFor('member', audit) as unknown as Record<string, unknown>;
      const db = base.db as Record<string, unknown>;
      const ctx = {
        ...base,
        db: new Proxy(db, {
          get: (t, k: string) =>
            k === 'policy'
              ? {
                  findMany: async () => [
                    { id: 'staging-remove', name: 's', effect: 'permit', priority: 10, enabled: true,
                      source: JSON.stringify({ actions: ['service.remove'], resourceLabels: { env: 'staging' } }) },
                  ],
                }
              : t[k],
        }),
        hub: new Proxy(base.hub as Record<string, unknown>, {
          get: (t, k: string) =>
            k === 'liveInventory' ? () => ({ services: [svc('web-staging', 'staging'), svc('web-prod', 'production')], containers: [] }) : t[k],
        }),
      };
      const caller = appRouter.createCaller(ctx as never);
      const error = await caller.services.remove({ id }).then(() => null, (e: unknown) => e);
      return { audit, error };
    };
    const staging = await run('web-staging');
    expect(staging.audit).toContain('authz.permit:service.remove');
    const prod = await run('web-prod');
    expect(isPolicyDenied(prod.error)).toBe(true);
    expect(prod.audit).toEqual(['authz.deny:service.remove']);
  });
});
