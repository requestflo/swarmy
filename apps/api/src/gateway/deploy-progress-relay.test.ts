import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { deployEventBus } from '@swarmy/trpc';
import { handleAgentMessage } from './protocol-handlers';
import { GatewayStore } from './store';

/** The agent's `deployProgress` frames reach the org's deploy stream — and only that org's. */
describe('gateway relays deployProgress into the deploy event bus', () => {
  const frame = (deployId: string) =>
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'deployProgress',
      payload: { deployId, stack: 'blog', service: 'blog_ghost', node: 'london-1', stage: 'pull', status: 'started', at: Date.now(), message: 'pulling ghost:5.96-alpine on london-1' },
    });
  const socket = (nodeId: string) => ({ data: { state: 'ready', nodeId }, send: () => undefined, close: () => undefined }) as never;

  it('keeps a frame from a node of the deploy’s org', async () => {
    const store = new GatewayStore();
    store.nodeOrg.set('n_a', 'org_relay_a');
    const id = deployEventBus.begin('org_relay_a', 'blog');
    await handleAgentMessage(socket('n_a'), frame(id), { hub: {} as never, store, registry: {} as never });
    expect(deployEventBus.get('org_relay_a', id)?.events.map((e) => e.message)).toEqual(['pulling ghost:5.96-alpine on london-1']);
    deployEventBus.finish(id);
  });

  it('drops a frame from another org’s node', async () => {
    const store = new GatewayStore();
    store.nodeOrg.set('n_b', 'org_relay_b');
    const id = deployEventBus.begin('org_relay_a', 'blog');
    await handleAgentMessage(socket('n_b'), frame(id), { hub: {} as never, store, registry: {} as never });
    expect(deployEventBus.get('org_relay_a', id)?.events).toEqual([]);
    deployEventBus.finish(id);
  });
});
