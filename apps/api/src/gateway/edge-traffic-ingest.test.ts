import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { handleAgentMessage } from './protocol-handlers';
import { GatewayStore } from './store';

/** `metrics.edge` from an edge agent lands in the org's traffic ring; older agents' frames still work. */
describe('gateway ingests metrics.edge into the edge-traffic ring', () => {
  const frame = (edge?: object) =>
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'metrics',
      payload: {
        sampledAt: Date.now(),
        node: { cpuPercent: 10, memUsedBytes: 1, memTotalBytes: 2 },
        containers: [],
        ...(edge ? { edge } : {}),
      },
    });
  const socket = (nodeId: string) => ({ data: { state: 'ready', nodeId }, send: () => undefined, close: () => undefined }) as never;
  const deps = (store: GatewayStore) => ({ hub: {} as never, store, registry: {} as never });

  it('records per-host deltas under the node`s org', async () => {
    const store = new GatewayStore();
    store.nodeOrg.set('edge1', 'org_t');
    await handleAgentMessage(
      socket('edge1'),
      frame({ sampledAt: 1, intervalSec: 15, hosts: [{ host: 'shop.test', requests: 42, errors5xx: 1 }] }),
      deps(store),
    );
    const cells = store.edgeTraffic.cells('org_t', 0, Number.MAX_SAFE_INTEGER);
    expect(cells.reduce((n, c) => n + c.requests, 0)).toBe(42);
    expect(cells.every((c) => c.nodeId === 'edge1' && c.host === 'shop.test')).toBe(true);
    expect(store.edgeTraffic.reports('org_t').has('edge1')).toBe(true);
    expect(store.nodeStats.get('edge1')?.memTotalBytes).toBe(2);
  });

  it('a metrics frame without edge (non-edge node / older agent) touches no ring', async () => {
    const store = new GatewayStore();
    store.nodeOrg.set('n1', 'org_t');
    await handleAgentMessage(socket('n1'), frame(), deps(store));
    expect(store.edgeTraffic.orgIds()).toEqual([]);
    expect(store.nodeStats.has('n1')).toBe(true);
  });
});
