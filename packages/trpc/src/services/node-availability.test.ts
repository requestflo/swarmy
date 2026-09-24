import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { setNodeAvailability } from './node.service';

/**
 * `docker node update` is manager-only. Drain/cordon/uncordon must dispatch to
 * a MANAGER agent, and must work for an OFFLINE target (retiring a dead server
 * starts with draining it). Found live: REST /nodes/{worker}/drain answered
 * "This node is not a swarm manager" and decommission of a dead node failed.
 */
function fakeCtx(opts: { online: Set<string>; manager?: string }) {
  const calls: { via: string; cmd: string; payload: unknown }[] = [];
  const ctx = {
    activeOrgId: 'org1',
    db: { node: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'missing' ? null : { id: where.id }) } },
    hub: {
      swarmNodeIdFor: (id: string) => `swarm-${id}`,
      managerNode: () => opts.manager,
      isOnline: (id: string) => opts.online.has(id),
      dispatch: async (via: string, cmd: string, payload: unknown) => {
        calls.push({ via, cmd, payload });
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, calls };
}

describe('setNodeAvailability', () => {
  it('drains a worker through the manager, not the worker itself', async () => {
    const { ctx, calls } = fakeCtx({ online: new Set(['mgr', 'w1']), manager: 'mgr' });
    await setNodeAvailability(ctx, 'w1', 'drain');
    expect(calls).toEqual([{ via: 'mgr', cmd: 'node.update', payload: { swarmNodeId: 'swarm-w1', availability: 'drain' } }]);
  });

  it('drains an OFFLINE server (retire a dead node)', async () => {
    const { ctx, calls } = fakeCtx({ online: new Set(['mgr']), manager: 'mgr' });
    await setNodeAvailability(ctx, 'dead', 'drain');
    expect(calls[0]?.via).toBe('mgr');
  });

  it('refuses with no manager online, and 404s an unknown node', async () => {
    const { ctx } = fakeCtx({ online: new Set(), manager: undefined });
    await expect(setNodeAvailability(ctx, 'w1', 'active')).rejects.toThrow(/no manager/);
    await expect(setNodeAvailability(ctx, 'missing', 'active')).rejects.toThrow();
  });
});
