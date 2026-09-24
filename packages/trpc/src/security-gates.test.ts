import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { appRouter } from './root';
import type { OrgContext } from './context';

/**
 * CI gate (auth-abac + testing-conventions): the security sweep of 2026-09-24.
 * Mutations that could weaken production safety, reach prod through a side
 * door (scheduler / workflow exec, managed data, ingress, node labels) or mint
 * an owner are gated. The live inventory below has a PRODUCTION stack `shop`
 * (its web service carries a route) and a production-labelled node, so the
 * seeded "members operate outside production" permit does not apply.
 * The gate runs before any service, so unmocked models only matter after a
 * permit (whatever they throw then is irrelevant).
 */

type Role = 'owner' | 'admin' | 'member';

const ROUTES = JSON.stringify([{ host: 'shop.example.com', port: 80, tls: 'auto', www: 'serve-both' }]);

const svc = (id: string, stack: string, labels: Record<string, string> = {}) => ({
  id, name: id, image: 'x', mode: 'replicated', replicas: 1, runningReplicas: 1, desiredReplicas: 1,
  labels: { 'com.docker.stack.namespace': stack, ...labels },
  networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
});

const LIVE = [
  svc('shop_web', 'shop', { 'swarmy.env': 'production', 'swarmy.ingress.routes': ROUTES }),
  svc('shop_db', 'shop'),
  svc('blog_web', 'blog', { 'swarmy.env': 'staging' }),
];

function ctxFor(role: Role, audit: string[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      node: { findFirst: async () => ({ id: 'n1', orgId: 'org1' }) },
      stack: { findFirst: async () => null },
      release: { findFirst: async () => ({ stackName: 'shop', composeSource: 'services: {}' }) },
      scheduledJob: { findFirst: async () => ({ kind: 'SERVICE_EXEC', serviceRef: 'blog_web' }) },
      workflowDef: {
        findFirst: async () => ({
          stepsJson: [{ name: 'migrate', kind: 'service-exec', config: { serviceRef: 'shop_web' } }],
        }),
      },
      invitation: { findFirst: async () => ({ role: 'owner' }) },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          audit.push(data.action);
          return {};
        },
      },
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t
          ? t[k]
          : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const hub = new Proxy(
    {
      liveInventory: () => ({ services: LIVE, containers: [] }),
      nodeInfoFor: () => ({ labels: { 'swarmy.env': 'production' } }),
    },
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

const isAdminOnly = (e: unknown) =>
  e instanceof TRPCError && e.code === 'FORBIDDEN' && e.message === 'requires admin or owner';

const shop = { stack: 'shop', cluster: 'pg' };

/** [procedure path, input, governed action] — resources resolve to production. */
const POLICY_GATES: Array<[string, unknown, string]> = [
  // H1 — releases on a production stack
  ['releases.rollback', { releaseId: 'r1' }, 'stack.deploy'],
  ['releases.startCanary', { stack: 'shop', service: 'shop_web', image: 'x:2' }, 'stack.deploy'],
  ['releases.promote', { stack: 'shop', service: 'shop_web' }, 'stack.deploy'],
  // H3 — ingress on a production service's domain
  ['ingress.addDomain', { host: 'a.example.com', serviceId: 'shop_web', targetPort: 80 }, 'ingress.write'],
  ['ingress.setServiceRoutes', { serviceId: 'shop_web', routes: [] }, 'ingress.write'],
  ['ingress.removeDomain', { id: 'shop_web:shop.example.com' }, 'ingress.write'],
  ['ingress.setDomainWww', { id: 'shop_web:shop.example.com', www: null }, 'ingress.write'],
  ['ingress.verifyDomain', { host: 'shop.example.com' }, 'ingress.write'],
  ['ingress.verifyDomain', { host: 'www.shop.example.com' }, 'ingress.write'],
  // H4 — managed data plane on a production stack
  ['db.provision', { stack: 'shop', name: 'pg', replicas: 0 }, 'stack.deploy'],
  ['db.setReplicas', { ...shop, replicas: 1 }, 'stack.deploy'],
  ['db.setTopology', { ...shop, topology: 'single' }, 'stack.deploy'],
  ['db.setWriteRegion', { ...shop, region: 'eu' }, 'stack.deploy'],
  ['db.setRegionReplicas', { ...shop, region: 'eu', replicas: 1 }, 'stack.deploy'],
  ['db.inject', { ...shop, appService: 'web' }, 'service.configure'],
  ['cache.provision', { stack: 'shop', name: 'kv' }, 'stack.deploy'],
  ['cache.setReplicas', { ...shop, replicas: 1 }, 'stack.deploy'],
  ['cache.setMemory', { ...shop, memoryMb: 128 }, 'stack.deploy'],
  ['cache.attachToService', { ...shop, appService: 'web' }, 'service.configure'],
  ['cache.detach', { ...shop, appService: 'web' }, 'service.configure'],
  ['search.provision', { stack: 'shop', name: 'idx' }, 'stack.deploy'],
  ['search.attachToService', { ...shop, appService: 'web' }, 'service.configure'],
  ['search.detach', { ...shop, appService: 'web' }, 'service.configure'],
  ['vector.provision', { stack: 'shop', name: 'vec' }, 'stack.deploy'],
  ['vector.attachToService', { ...shop, appService: 'web' }, 'service.configure'],
  ['vector.detach', { ...shop, appService: 'web' }, 'service.configure'],
  ['vector.enablePgvector', { ...shop }, 'stack.deploy'],
  ['dbBackups.setSchedule', { ...shop, enabled: false }, 'stack.deploy'],
  ['backups.backupVolume', { targetId: 't1', volume: 'shop_data', retentionDays: 1 }, 'data.destroy'],
  // H5 — production node
  ['nodes.setLabels', { id: 'n1', labels: {} }, 'node.setLabels'],
  ['nodes.activate', { id: 'n1' }, 'node.drain'],
  // C2 — scheduler / workflow exec needs a shell grant (even outside prod)
  ['jobs.create', { name: 'j', schedule: '* * * * *', kind: 'service-exec', serviceRef: 'blog_web' }, 'terminal.open'],
  ['jobs.update', { id: 'j1', command: ['sh'] }, 'terminal.open'],
  ['jobs.runNow', { id: 'j1' }, 'terminal.open'],
  ['jobs.toggle', { id: 'j1', enabled: true }, 'terminal.open'],
  [
    'workflows.create',
    { name: 'w', steps: [{ name: 's', kind: 'service-exec', config: { serviceRef: 'shop_web' } }] },
    'terminal.open',
  ],
  [
    'workflows.update',
    { name: 'w', steps: [{ name: 's', kind: 'service-exec', config: { serviceRef: 'blog_web' } }] },
    'terminal.open',
  ],
  ['workflows.trigger', { name: 'w' }, 'terminal.open'],
];

/** Admin-only (adminProcedure) — a member is refused outright. */
const ADMIN_GATES: Array<[string, unknown]> = [
  ['guardrails.setStackEnv', { stack: 'shop', production: false }],
  ['guardrails.setSafetyMode', { enabled: false }],
  ['guardrails.setRule', { rule: 'no-latest-tag-in-prod', enabled: false }],
  ['exposure.setRules', { enforce: false }],
  ['exposure.setMode', { id: 'shop_web', mode: null }],
  ['releases.setSafety', { stackName: 'shop', enabled: false }],
  ['workflows.approve', { runId: 'r1' }],
  ['workflows.reject', { runId: 'r1' }],
  ['db.migrateStorage', { ...shop, skipBackup: true }],
];

describe('security sweep: production-reaching mutations are policy-gated', () => {
  for (const [path, input, action] of POLICY_GATES) {
    it(`${path} → ${action}: owner + admin permitted (no lockout)`, async () => {
      for (const role of ['owner', 'admin'] as const) {
        const { audit, error } = await call(role, path, input);
        expect(audit).toContain(`authz.permit:${action}`);
        expect(isPolicyDenied(error)).toBe(false);
      }
    });

    it(`${path} → ${action}: member refused (audited)`, async () => {
      const { audit, error } = await call('member', path, input);
      expect(isPolicyDenied(error)).toBe(true);
      expect(audit).toEqual([`authz.deny:${action}`]);
    });
  }
});

describe('security sweep: governance switches are admin-only', () => {
  for (const [path, input] of ADMIN_GATES) {
    it(`${path}: member refused`, async () => {
      const { error } = await call('member', path, input);
      expect(isAdminOnly(error)).toBe(true);
    });

    it(`${path}: admin passes the gate`, async () => {
      const { error } = await call('admin', path, input);
      expect(isAdminOnly(error)).toBe(false);
    });
  }
});

describe('security sweep: members keep safe ops outside production', () => {
  it('an image job only needs service.deploy (non-production)', async () => {
    const { audit, error } = await call('member', 'jobs.create', {
      name: 'j', schedule: '* * * * *', kind: 'image', image: 'alpine:3',
    });
    expect(audit).toContain('authz.permit:service.deploy');
    expect(isPolicyDenied(error)).toBe(false);
  });

  it('a staging stack DB provision is member-permitted', async () => {
    const { audit, error } = await call('member', 'db.provision', { stack: 'blog', name: 'pg', replicas: 0 });
    expect(audit).toContain('authz.permit:stack.deploy');
    expect(isPolicyDenied(error)).toBe(false);
  });

  it('a backup without a retention override is not gated', async () => {
    const { audit } = await call('member', 'backups.backupVolume', { targetId: 't1', volume: 'shop_data' });
    expect(audit.some((a) => a.startsWith('authz.'))).toBe(false);
  });
});

describe('security sweep: only an owner mints an owner', () => {
  it('admin cannot invite an owner', async () => {
    const { error } = await call('admin', 'members.invite', { role: 'owner' });
    expect(error instanceof TRPCError && error.code === 'FORBIDDEN').toBe(true);
    expect((error as Error).message).toBe('only an owner can invite an owner');
  });

  it('admin cannot reissue an owner invite', async () => {
    const { error } = await call('admin', 'members.regenerateInvitation', { id: 'inv1' });
    expect((error as Error).message).toBe('only an owner can reissue an owner invite');
  });

  it('owner passes the owner-invite check', async () => {
    const { error } = await call('owner', 'members.invite', { role: 'owner' });
    expect((error as Error | null)?.message).not.toBe('only an owner can invite an owner');
  });
});
