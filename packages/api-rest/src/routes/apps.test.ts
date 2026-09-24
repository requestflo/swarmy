import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';
import { appPlanToDto, appToDto } from './apps';

/**
 * /apps REST parity: flat public plan shape, admin gates mirroring the tRPC
 * router's adminProcedure, the per-step ABAC denial surfacing as 403, and the
 * /apps/plans/{id} vs /apps/{repoId}/… route precedence.
 */

type Role = 'owner' | 'admin' | 'member';

const planRow = {
  id: 'p1',
  orgId: 'org1',
  repoId: 'gr1',
  environment: 'production',
  stack: 'shop',
  sha: 'a'.repeat(40),
  trigger: 'push',
  prNumber: 0,
  status: 'needs-confirmation',
  planJson: {
    stack: 'shop',
    status: 'needs-confirmation',
    counts: { auto: 1, confirm: 1, blocked: 0 },
    actions: [
      { id: 'service.deploy:web', kind: 'service.deploy', phase: 4, gate: 'auto', reason: 'deploy web' },
      { id: 'resource.delete:files', kind: 'resource.delete', phase: 6, gate: 'confirm', reason: 'delete bucket files', name: 'files', resourceType: 'bucket' },
    ],
  },
  issuesJson: [{ severity: 'warning', code: 'x/y', message: 'm', path: ['services', 'web', 0] }],
  resultsJson: { 'service.deploy:web': { status: 'done' }, 'resource.delete:files': { status: 'held', message: 'waiting' } },
  desiredJson: { stack: 'shop', resources: [] },
  error: null,
  confirmedIds: [],
  createdAt: new Date('2026-09-24T00:00:00Z'),
  appliedAt: null,
};

function appFor(role: Role, audit: string[] = []) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      appPlan: {
        findFirst: async ({ where }: { where: { id?: string } }) =>
          where.id === undefined || where.id === 'p1' ? planRow : null,
        findMany: async () => [planRow],
      },
      gitRepo: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === 'gr1' ? { id: 'gr1', orgId: 'org1', requireApproval: false, configPath: 'swarmy.yaml' } : null,
        findMany: async () => [],
        update: async () => ({}),
      },
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
  const ctx = {
    db,
    hub: { liveInventory: () => ({ services: [], containers: [] }), nodeInfoFor: () => undefined },
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['write'] } }),
  });
}

async function call(role: Role, method: string, path: string, body?: unknown) {
  const res = await appFor(role).request(path, {
    method,
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('/apps REST routes', () => {
  it('GET /apps/plans/{id} is the plan route (not /apps/{repoId}/…) and is flat', async () => {
    const r = await call('member', 'GET', '/apps/plans/p1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id: 'p1',
      plan_status: 'needs-confirmation',
      counts: { auto: 1, confirm: 1, blocked: 0 },
      pr_number: null,
      issues: [{ path: 'services.web.0', line: null, col: null }],
    });
    expect((r.json.actions as unknown[])[1]).toEqual({
      id: 'resource.delete:files',
      kind: 'resource.delete',
      phase: 6,
      gate: 'confirm',
      reason: 'delete bucket files',
      outcome: 'held',
      outcome_message: 'waiting',
    });
  });
  it('GET /apps/{repoId}/plans validates limit', async () => {
    expect((await call('member', 'GET', '/apps/gr1/plans?limit=5')).status).toBe(200);
    expect((await call('member', 'GET', '/apps/gr1/plans?limit=500')).status).toBe(400);
  });
  it('require-approval and deploy are admin-only', async () => {
    const a = await call('member', 'PUT', '/apps/gr1/require-approval', { require_approval: true });
    expect(a.status).toBe(403);
    expect(a.json.swarmy_code).toBe('POLICY_DENIED');
    expect((await call('member', 'POST', '/apps/gr1/deploy', {})).status).toBe(403);
    const ok = await call('admin', 'PUT', '/apps/gr1/require-approval', { require_approval: true });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ repo_id: 'gr1', require_approval: true });
  });
  it('enforce-drift is admin-only and round-trips', async () => {
    expect((await call('member', 'PUT', '/apps/gr1/enforce-drift', { enforce_drift: true })).status).toBe(403);
    const ok = await call('admin', 'PUT', '/apps/gr1/enforce-drift', { enforce_drift: true });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ repo_id: 'gr1', enforce_drift: true });
  });
  it('purge: member refused by data.destroy at the route; a wrong typed confirmation is 400', async () => {
    const m = await call('member', 'POST', '/apps/gr1/environments/production/purge', { resource: 'db', confirm: 'shop/db' });
    expect(m.status).toBe(403);
    expect(m.json.swarmy_code).toBe('POLICY_DENIED');
    const bad = await call('admin', 'POST', '/apps/gr1/environments/production/purge', { resource: 'db', confirm: 'db' });
    expect(bad.status).toBe(400);
    expect(String(bad.json.detail)).toContain('shop/db');
  });
  it('confirm → 404 problem for an unknown plan; body needs ≥1 id', async () => {
    expect((await call('admin', 'POST', '/apps/plans/nope/confirm', { action_ids: ['x'] })).status).toBe(404);
    expect((await call('admin', 'POST', '/apps/plans/p1/confirm', { action_ids: [] })).status).toBe(400);
  });
});

describe('apps mappers', () => {
  it('a plan whose config did not parse maps to zero counts and no actions', () => {
    const dto = appPlanToDto({
      id: 'p', repoId: 'r', environment: 'production', stack: '', sha: 's', trigger: 'push', prNumber: null,
      status: 'failed', plan: null, issues: [], outcomes: {}, error: 'bad yaml', confirmedIds: [], markdown: '',
      createdAt: 'now', appliedAt: null,
    });
    expect(dto).toMatchObject({ plan_status: null, counts: { auto: 0, confirm: 0, blocked: 0 }, actions: [] });
  });
  it('app environments flatten the latest plan', () => {
    const dto = appToDto({
      repoId: 'r', url: 'u', fullName: null, branch: 'main', configPath: 'swarmy.yaml', appName: 'shop',
      requireApproval: true,
      enforceDrift: false,
      environments: [{ environment: 'staging', branch: 'staging', stack: 'shop-staging', latest: null }],
      previews: [{ pr: 7, stack: 'shop-pr-7', sha: 'abc', status: 'applied', url: null, updatedAt: 'now', planId: 'p7' }],
      drift: { checkedAt: 'then', environments: [{ environment: 'production', stack: 'shop', changes: 2 }] },
    });
    expect(dto.previews).toEqual([
      { pr: 7, stack: 'shop-pr-7', sha: 'abc', status: 'applied', url: null, updated_at: 'now', plan_id: 'p7' },
    ]);
    expect(dto.drift).toEqual({ checked_at: 'then', environments: [{ environment: 'production', stack: 'shop', changes: 2 }] });
    expect(
      appToDto({
        repoId: 'r', url: 'u', fullName: null, branch: 'main', configPath: 'swarmy.yaml', appName: null,
        requireApproval: false, enforceDrift: false, environments: [], previews: [], drift: null,
      }).drift,
    ).toBeNull();
    expect(dto.environments[0]).toEqual({
      environment: 'staging', branch: 'staging', stack: 'shop-staging',
      latest_plan_id: null, latest_plan_status: null, latest_sha: null, latest_created_at: null,
    });
  });
});
