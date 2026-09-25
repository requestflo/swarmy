import { describe, expect, it } from 'bun:test';
import { getFailoverReadiness, setTopology } from './manageddb.service';

/** QA-058: `failover` is refused where the topology can't honestly provide it. */
function ctxWith(nodes: number, primaryLabels: Record<string, string>) {
  const dispatched: string[] = [];
  const primary = {
    id: 'p', name: 'shop_db-primary', image: 'postgres:17', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'primary', 'swarmy.db.engine': 'postgres', ...primaryLabels },
    networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
  };
  const ctx = {
    activeOrgId: 'o',
    user: { id: 'u' },
    db: { auditLog: { create: async ({ data }: any) => data } },
    hub: {
      liveInventory: () => ({ services: [primary], containers: [] }),
      nodeInventory: () => Array.from({ length: nodes }, (_, i) => ({ swarmNodeId: `n${i}`, hostname: `h${i}`, role: 'manager', status: 'ready', availability: 'active', labels: {} })),
      managerNode: () => 'n1',
      isOnline: () => true,
      dispatch: async (_n: string, cmd: string) => {
        dispatched.push(cmd);
        return {};
      },
    },
  } as never;
  return { ctx, dispatched };
}

describe('failover topology', () => {
  it('one server: setTopology failover is refused with the reason, nothing changes', async () => {
    const { ctx, dispatched } = ctxWith(1, { 'swarmy.db.replicas': '1', 'swarmy.db.node': 'n0' });
    await expect(setTopology(ctx, { stack: 'shop', cluster: 'db', topology: 'failover' })).rejects.toThrow(/at least 2 servers/);
    expect(dispatched).toEqual([]);
  });

  it('two servers, a replica, pinned primary: readiness ok and the topology applies', async () => {
    const { ctx, dispatched } = ctxWith(2, { 'swarmy.db.replicas': '1', 'swarmy.db.node': 'n0' });
    expect(getFailoverReadiness(ctx, { stack: 'shop', cluster: 'db' }).ok).toBe(true);
    await setTopology(ctx, { stack: 'shop', cluster: 'db', topology: 'failover' }).catch(() => undefined);
    expect(dispatched).toContain('service.updateLabels');
  });

  it('other topologies are not gated by failover readiness', async () => {
    const { ctx, dispatched } = ctxWith(1, {});
    await setTopology(ctx, { stack: 'shop', cluster: 'db', topology: 'primary-replica' }).catch(() => undefined);
    expect(dispatched).toContain('service.updateLabels');
  });
});
