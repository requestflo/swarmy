import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { appRouter } from './root';
import type { OrgContext } from './context';

/**
 * Queue studio ABAC gates, under the seeded defaults:
 *   - writes (retry, retryAll, promote, promoteAll, pause) need `data.write`,
 *   - removing jobs (remove, clean) and draining need `data.destroy`,
 *   - reads (overview, jobs, job, rates) need `data.read`. Members get it
 *     outside production and are refused on a production stack.
 * The policy step runs before the resolver. A permit shows up as an
 * `authz.permit:<action>` audit row, and whatever the (unmocked) service
 * then throws doesn't matter here.
 */

type Role = 'owner' | 'admin' | 'member';

function ctxFor(role: Role, audit: string[], env?: string) {
  const services = env
    ? [
        {
          id: 'svc1',
          name: 'shop_web',
          image: 'x',
          mode: 'replicated',
          replicas: 1,
          runningReplicas: 1,
          desiredReplicas: 1,
          labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.env': env },
          networks: [],
          env: [],
          ports: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ]
    : [];
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
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
    { liveInventory: () => ({ services, containers: [] }), nodeInfoFor: () => undefined },
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

async function call(role: Role, path: string, input: unknown, env?: string) {
  const audit: string[] = [];
  const caller = appRouter.createCaller(ctxFor(role, audit, env) as never) as unknown as Record<string, unknown>;
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

const denied = (e: unknown) =>
  e instanceof TRPCError &&
  e.code === 'FORBIDDEN' &&
  (e.cause as { swarmyCode?: string } | undefined)?.swarmyCode === 'POLICY_DENIED';

const ref = { stack: 'shop', cluster: 'jobs', queue: 'emails' };
const WRITES: Array<[string, unknown, string]> = [
  ['queues.studioRetry', { ...ref, id: '1' }, 'data.write'],
  ['queues.studioRetryAll', ref, 'data.write'],
  ['queues.studioPromote', { ...ref, id: '1' }, 'data.write'],
  ['queues.studioPromoteAll', ref, 'data.write'],
  ['queues.studioPause', { ...ref, paused: true }, 'data.write'],
  ['queues.studioRemove', { ...ref, id: '1' }, 'data.destroy'],
  ['queues.studioClean', { ...ref, state: 'completed' }, 'data.destroy'],
  ['queues.drain', { workerService: 'w', queue: 'q' }, 'data.destroy'],
];
const READS: Array<[string, unknown]> = [
  ['queues.studioOverview', { stack: 'shop', cluster: 'jobs' }],
  ['queues.studioJobs', { ...ref, state: 'failed' }],
  ['queues.studioJob', { ...ref, id: '1' }],
  ['queues.studioRates', ref],
];

describe('queue studio writes are ABAC-gated', () => {
  for (const [path, input, action] of WRITES) {
    it(`${path} → ${action}: owner + admin permitted, member refused (audited)`, async () => {
      for (const role of ['owner', 'admin'] as const) {
        const { audit, error } = await call(role, path, input);
        expect(audit).toContain(`authz.permit:${action}`);
        expect(denied(error)).toBe(false);
      }
      const m = await call('member', path, input);
      expect(denied(m.error)).toBe(true);
      expect(m.audit).toEqual([`authz.deny:${action}`]);
    });
  }
});

describe('queue studio reads need data.read', () => {
  for (const [path, input] of READS) {
    it(`${path}: a member reads a non-production stack, not a production one`, async () => {
      const staging = await call('member', path, input, 'staging');
      expect(staging.audit).toContain('authz.permit:data.read');
      expect(denied(staging.error)).toBe(false);
      const prod = await call('member', path, input, 'production');
      expect(denied(prod.error)).toBe(true);
      expect(prod.audit).toEqual(['authz.deny:data.read']);
      const admin = await call('admin', path, input, 'production');
      expect(admin.audit).toContain('authz.permit:data.read');
    });
  }
});
