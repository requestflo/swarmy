import { describe, expect, it } from 'bun:test';
import { AgentHubImpl } from './hub';
import { GatewayStore } from './store';
import type { ConnectionRegistry } from './registry';

describe('hub dispatch decorator', () => {
  it("gets the target node, so a payload can follow that agent's capabilities", async () => {
    const store = new GatewayStore();
    store.nodeOrg.set('n1', 'org1');
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry = { isOnline: () => true, send: (_n: string, f: never) => sent.push(f) } as unknown as ConnectionRegistry;
    const hub = new AgentHubImpl(store, registry);
    const seen: unknown[] = [];
    hub.setDispatchDecorator(async (orgId, cmd, payload, nodeId) => {
      seen.push([orgId, cmd, nodeId]);
      return { ...(payload as object), image: `mirrored-for-${nodeId}` };
    });

    const done = hub.dispatch('n1', 'backup.list', { repo: { kind: 'node', repo: '/srv/b', password: 'p' } }, { timeoutMs: 1_000 });
    await Bun.sleep(0);
    expect(seen).toEqual([['org1', 'backup.list', 'n1']]);
    expect(sent[0]?.type).toBe('listSnapshots');
    expect(sent[0]?.payload.image).toBe('mirrored-for-n1');
    hub.settleCommand(sent[0]!.payload.commandId as string, true, { snapshots: [] });
    await done;
  });
});
