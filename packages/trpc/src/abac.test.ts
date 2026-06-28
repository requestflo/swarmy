import { describe, expect, it } from 'bun:test';
import { buildPrincipal, evaluateAccess, resolveNode, resolveService } from './abac';
import type { OrgContext } from './context';

/**
 * A mock OrgContext backed by in-memory tables. Only the methods the ABAC seam
 * touches are implemented (member, policy, resourceGrant, node, service).
 */
function mockCtx(opts: {
  role?: 'owner' | 'admin' | 'member';
  memberAttributes?: Record<string, unknown>;
  memberId?: string;
  policies?: { id: string; name: string; effect: string; source: string; priority: number; enabled: boolean }[];
  grants?: {
    principalType: string;
    principalId: string;
    resourceType: string;
    resourceId: string;
    relation: string;
  }[];
  nodes?: { id: string; orgId: string; labels: Record<string, unknown> }[];
  services?: { id: string; orgId: string; labels?: Record<string, string> }[];
}): OrgContext {
  const orgId = 'org1';
  const memberId = opts.memberId ?? 'mem1';
  const db = {
    member: {
      findFirst: async () => ({ id: memberId, role: opts.role ?? 'member', attributes: opts.memberAttributes ?? {} }),
    },
    policy: {
      findMany: async () => opts.policies ?? [],
    },
    resourceGrant: {
      findMany: async ({ where }: { where: { resourceType: string; resourceId: string } }) =>
        (opts.grants ?? []).filter(
          (g) => g.resourceType === where.resourceType && g.resourceId === where.resourceId,
        ),
    },
    node: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        (opts.nodes ?? []).find((n) => n.id === where.id) ?? null,
    },
    service: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        (opts.services ?? []).find((s) => s.id === where.id) ?? null,
    },
    auditLog: { create: async () => ({}) },
  };
  // Node swarm labels are Docker-truth now: resolveNode reads them from the hub
  // (the DB only confirms enrollment existence).
  const hub = {
    nodeInfoFor: (id: string) => {
      const n = (opts.nodes ?? []).find((x) => x.id === id);
      return n ? { labels: n.labels } : undefined;
    },
    // resolveService reads services from the live inventory (no Service model).
    liveInventory: () => ({
      services: (opts.services ?? []).map((s) => ({
        id: s.id,
        name: s.id,
        image: '',
        mode: 'replicated',
        replicas: 1,
        runningReplicas: 1,
        desiredReplicas: 1,
        labels: s.labels ?? {},
        networks: [],
        env: [],
        ports: [],
        createdAt: 0,
        updatedAt: 0,
      })),
      containers: [],
    }),
  };
  return {
    db,
    hub,
    activeOrgId: orgId,
    user: { id: 'user1' },
    membership: { role: opts.role ?? 'member', orgId },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

describe('buildPrincipal', () => {
  it('derives role, memberId, teamIds and attributes from the member row', async () => {
    const ctx = mockCtx({ role: 'admin', memberId: 'm7', memberAttributes: { team: 'payments', teamIds: ['t1'] } });
    const p = await buildPrincipal(ctx);
    expect(p.roles).toEqual(['admin']);
    expect(p.memberId).toBe('m7');
    expect(p.teamIds).toEqual(['t1']);
    expect(p.attributes.team).toBe('payments');
  });
});

describe('evaluateAccess (default policies)', () => {
  it('permits owner on a destructive action', async () => {
    const ctx = mockCtx({ role: 'owner' });
    const r = await evaluateAccess(ctx, 'service.remove', null);
    expect(r.decision).toBe('permit');
  });

  it('denies a member a destructive action', async () => {
    const ctx = mockCtx({ role: 'member' });
    const r = await evaluateAccess(ctx, 'service.remove', null);
    expect(r.decision).toBe('deny');
  });

  it('permits a member a safe op', async () => {
    const ctx = mockCtx({ role: 'member' });
    const r = await evaluateAccess(ctx, 'service.restart', null);
    expect(r.decision).toBe('permit');
  });
});

describe('evaluateAccess with custom policies + ReBAC grants', () => {
  it('permits an operator (via grant) to restart a service even as a plain member', async () => {
    const ctx = mockCtx({
      role: 'member',
      memberId: 'mem1',
      // No org-wide safe-ops — only the operator-resource-ops style rule.
      policies: [
        {
          id: 'op',
          name: 'operators restart',
          effect: 'permit',
          priority: 10,
          enabled: true,
          source: JSON.stringify({ relations: ['operator'], actions: ['service.restart'] }),
        },
      ],
      grants: [
        { principalType: 'member', principalId: 'mem1', resourceType: 'service', resourceId: 'svc1', relation: 'operator' },
      ],
      services: [{ id: 'svc1', orgId: 'org1' }],
    });
    const resource = await resolveService(ctx, { id: 'svc1' });
    const r = await evaluateAccess(ctx, 'service.restart', resource);
    expect(r.decision).toBe('permit');
    expect(r.resource?.principalRelations).toContain('operator');
  });

  it('forbid policy wins over a permit', async () => {
    const ctx = mockCtx({
      role: 'owner',
      policies: [
        { id: 'allow', name: 'a', effect: 'permit', priority: 1, enabled: true, source: JSON.stringify({ actions: ['*'] }) },
        {
          id: 'freeze',
          name: 'freeze prod',
          effect: 'forbid',
          priority: 99,
          enabled: true,
          source: JSON.stringify({ actions: ['node.remove'], resourceLabels: { env: 'prod' } }),
        },
      ],
      nodes: [{ id: 'n1', orgId: 'org1', labels: { env: 'prod' } }],
    });
    const resource = await resolveNode(ctx, { id: 'n1' });
    const r = await evaluateAccess(ctx, 'node.remove', resource);
    expect(r.decision).toBe('deny');
    expect(r.policyId).toBe('freeze');
  });
});

describe('evaluateAccess terminal.open (highest-risk action)', () => {
  it('permits owner to open a terminal by default', async () => {
    const ctx = mockCtx({ role: 'owner' });
    const r = await evaluateAccess(ctx, 'terminal.open', null);
    expect(r.decision).toBe('permit');
  });

  it('permits admin to open a terminal by default', async () => {
    const ctx = mockCtx({ role: 'admin' });
    const r = await evaluateAccess(ctx, 'terminal.open', null);
    expect(r.decision).toBe('permit');
  });

  it('denies a plain member by default (not in member-safe-ops)', async () => {
    const ctx = mockCtx({ role: 'member' });
    const r = await evaluateAccess(ctx, 'terminal.open', null);
    expect(r.decision).toBe('deny');
  });

  it('a forbid policy on a prod node blocks even an owner', async () => {
    const ctx = mockCtx({
      role: 'owner',
      policies: [
        { id: 'allow', name: 'a', effect: 'permit', priority: 1, enabled: true, source: JSON.stringify({ actions: ['*'] }) },
        {
          id: 'no-prod-shell',
          name: 'no prod shells',
          effect: 'forbid',
          priority: 99,
          enabled: true,
          source: JSON.stringify({ actions: ['terminal.open'], resourceLabels: { env: 'prod' } }),
        },
      ],
      nodes: [{ id: 'n1', orgId: 'org1', labels: { env: 'prod' } }],
    });
    const resource = await resolveNode(ctx, { id: 'n1' });
    const r = await evaluateAccess(ctx, 'terminal.open', resource);
    expect(r.decision).toBe('deny');
    expect(r.policyId).toBe('no-prod-shell');
  });
});

describe('resource resolvers', () => {
  it('resolveNode returns null for an unknown id', async () => {
    const ctx = mockCtx({ nodes: [] });
    expect(await resolveNode(ctx, { id: 'nope' })).toBeNull();
  });

  it('resolveNode maps labels', async () => {
    const ctx = mockCtx({ nodes: [{ id: 'n1', orgId: 'org1', labels: { env: 'staging' } }] });
    const r = await resolveNode(ctx, { id: 'n1' });
    expect(r).toEqual({ type: 'node', id: 'n1', orgId: 'org1', labels: { env: 'staging' } });
  });
});
