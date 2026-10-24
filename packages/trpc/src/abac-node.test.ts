import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { evaluateAccess, resolveNode } from './abac';
import type { OrgContext } from './context';

/**
 * Security review M4: a node id that doesn't resolve is NOT_FOUND (never "no
 * resource, authorize as the org"), and an offline node must not look
 * non-production just because its labels aren't in memory.
 */

type Info = { hostname: string; status: string; labels: Record<string, string> };

function ctxFor(role: 'admin' | 'member', hub: { live?: Record<string, Info>; managerList?: Info[] }) {
  return {
    db: {
      member: { findFirst: async () => ({ id: 'm1', role, attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      node: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          ['n-live', 'n-down'].includes(where.id) ? { id: where.id, orgId: 'org1', hostname: `${where.id}.host` } : null,
      },
    },
    hub: {
      nodeInfoFor: (id: string) => hub.live?.[id],
      nodeInventory: (_org: string, includeOffline?: boolean) => (includeOffline ? (hub.managerList ?? []) : []),
    },
    activeOrgId: 'org1',
    user: { id: 'u1' },
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

const drain = async (ctx: OrgContext, id: string) =>
  (await evaluateAccess(ctx, 'node.drain', await resolveNode(ctx, { id }))).decision;

describe('resolveNode fails closed (security review M4)', () => {
  it('an id that is not a node of this org is NOT_FOUND', async () => {
    const e = await Promise.resolve(resolveNode(ctxFor('member', {}), { id: 'n-other' })).catch((x: unknown) => x);
    expect(e instanceof TRPCError && e.code === 'NOT_FOUND').toBe(true);
  });

  it('a live node is judged on its labels', async () => {
    const live = { 'n-live': { hostname: 'n-live.host', status: 'ready', labels: { 'swarmy.env': 'production' } } };
    expect(await drain(ctxFor('member', { live }), 'n-live')).toBe('deny');
    const staging = { 'n-live': { hostname: 'n-live.host', status: 'ready', labels: {} } };
    expect(await drain(ctxFor('member', { live: staging }), 'n-live')).toBe('permit');
  });

  it('an offline node nobody reports is production: members are refused, admins are not', async () => {
    const r = await resolveNode(ctxFor('member', {}), { id: 'n-down' });
    expect(r?.labels).toEqual({ 'swarmy.env': 'production' });
    expect(await drain(ctxFor('member', {}), 'n-down')).toBe('deny');
    expect(await drain(ctxFor('admin', {}), 'n-down')).toBe('permit');
  });

  it('an offline node a manager still lists (by hostname) keeps its real labels', async () => {
    const managerList: Info[] = [
      { hostname: 'other.host', status: 'ready', labels: { 'swarmy.env': 'production' } },
      { hostname: 'n-down.host', status: 'down', labels: { 'swarmy.region': 'eu' } },
    ];
    const r = await resolveNode(ctxFor('member', { managerList }), { id: 'n-down' });
    expect(r?.labels).toEqual({ 'swarmy.region': 'eu' });
    expect(await drain(ctxFor('member', { managerList }), 'n-down')).toBe('permit');
  });
});
