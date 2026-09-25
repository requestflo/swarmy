import { describe, expect, it } from 'bun:test';
import { SPEC_SIGNATURE_LABEL } from '@swarmy/trpc';
import { AgentHubImpl } from './hub';
import { GatewayStore } from './store';
import type { ConnectionRegistry } from './registry';

describe('hub gates system-service deploys', () => {
  it('a converge that re-sends the same desired spec dispatches nothing the second time', async () => {
    const store = new GatewayStore();
    store.nodeOrg.set('n1', 'org1');
    const sent: Array<{ type: string; payload: any }> = [];
    const registry = { isOnline: () => true, send: (_n: string, f: any) => sent.push(f) } as unknown as ConnectionRegistry;
    const hub = new AgentHubImpl(store, registry);
    const spec = { name: 'swarmy-garage', image: 'dxflrs/garage@sha256:9c', labels: { 'swarmy.system': 'true' } };

    const first = hub.dispatch('n1', 'service.deploy', { spec, pullPolicy: 'missing' }, { timeoutMs: 1_000 });
    const frame = sent[0]!;
    expect(frame.type).toBe('deployService');
    const sig = frame.payload.spec.labels[SPEC_SIGNATURE_LABEL];
    hub.settleCommand(frame.payload.commandId, true, { serviceId: 'g1', created: true });
    await first;

    // The inventory now shows the service with the stamped signature.
    store.serviceInfo.set('n1', [
      { id: 'g1', name: 'swarmy-garage', image: spec.image, mode: 'replicated', runningReplicas: 1, labels: { ...spec.labels, [SPEC_SIGNATURE_LABEL]: sig }, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0 } as never,
    ]);
    const again = await hub.dispatch('n1', 'service.deploy', { spec, pullPolicy: 'missing' });
    expect(again).toMatchObject({ serviceId: 'g1', unchanged: true });
    expect(sent).toHaveLength(1);
  });
});
