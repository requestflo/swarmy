import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { AgentHubImpl } from './hub';
import { handleAgentMessage } from './protocol-handlers';
import { GatewayStore } from './store';

/** `metrics.volumes` lands in the hub's memory; a frame without it (older agent, or between measurements) keeps the last report. */
describe('gateway keeps each server`s volume sizes in memory', () => {
  const frame = (volumes?: object) =>
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'metrics',
      payload: {
        sampledAt: Date.now(),
        node: { cpuPercent: 10, memUsedBytes: 1, memTotalBytes: 2 },
        containers: [],
        ...(volumes ? { volumes } : {}),
      },
    });
  let closed = false;
  const socket = (nodeId: string) =>
    ({ data: { state: 'ready', nodeId }, send: () => undefined, close: () => void (closed = true) }) as never;
  const deps = (store: GatewayStore) => ({ hub: {} as never, store, registry: {} as never });

  it('stores the latest report per node and serves it from the hub', async () => {
    const store = new GatewayStore();
    const sample = { sampledAt: 7, volumes: [{ name: 'shop_pg', sizeBytes: 4_200_000_000 }] };
    await handleAgentMessage(socket('n1'), frame(sample), deps(store));
    expect(store.volumeSizes.get('n1')).toEqual(sample);
    const hub = new AgentHubImpl(store, {} as never);
    expect(hub.volumeSizesFor('n1')).toEqual(sample);
    expect(hub.volumeSizesFor('n2')).toBeUndefined();
  });

  it('a metrics frame without volumes keeps the last report; one with them replaces it', async () => {
    const store = new GatewayStore();
    await handleAgentMessage(socket('n1'), frame({ sampledAt: 1, volumes: [{ name: 'a', sizeBytes: 1 }] }), deps(store));
    await handleAgentMessage(socket('n1'), frame(), deps(store));
    expect(store.volumeSizes.get('n1')?.volumes).toEqual([{ name: 'a', sizeBytes: 1 }]);
    await handleAgentMessage(socket('n1'), frame({ sampledAt: 2, volumes: [] }), deps(store));
    expect(store.volumeSizes.get('n1')).toEqual({ sampledAt: 2, volumes: [] });
    expect(closed).toBe(false);
  });

  it('survives a disconnect: the data is still on that server`s disk', () => {
    const store = new GatewayStore();
    store.volumeSizes.set('n1', { sampledAt: 1, volumes: [] });
    store.forget('n1');
    expect(store.volumeSizes.has('n1')).toBe(true);
  });
});
