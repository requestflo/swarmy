import { describe, expect, it } from 'bun:test';
import { PROGRESS_IDLE_TIMEOUT_MS, PROGRESS_MAX_TIMEOUT_MS } from '@swarmy/core/protocol';
import { AgentHubImpl, progressDeadlineMs } from './hub';
import { GatewayStore } from './store';
import type { ConnectionRegistry } from './registry';

describe('progressDeadlineMs', () => {
  it('re-arms to the idle budget, never below the command base budget', () => {
    expect(progressDeadlineMs(120_000, 0, 1_000)).toBe(PROGRESS_IDLE_TIMEOUT_MS);
    // A long base budget keeps its own ceiling (4h from dispatch), never shortened.
    expect(progressDeadlineMs(4 * 3_600_000, 0, 1_000)).toBe(4 * 3_600_000 - 1_000);
  });
  it('is capped by the ceiling from dispatch, so endless progress still ends', () => {
    const now = PROGRESS_MAX_TIMEOUT_MS - 10_000;
    expect(progressDeadlineMs(120_000, 0, now)).toBe(10_000);
    expect(progressDeadlineMs(120_000, 0, PROGRESS_MAX_TIMEOUT_MS + 1)).toBe(0);
  });
});

function hubWithNode() {
  const store = new GatewayStore();
  store.nodeOrg.set('n1', 'org1');
  const sent: Array<{ type: string; payload: { commandId: string } }> = [];
  const registry = {
    isOnline: () => true,
    send: (_n: string, f: { type: string; payload: { commandId: string } }) => sent.push(f),
  } as unknown as ConnectionRegistry;
  return { hub: new AgentHubImpl(store, registry), sent };
}

describe('deploy progress on the hub', () => {
  it('a progress frame outlives the base timeout and shows as the deploy phase until it settles', async () => {
    const { hub, sent } = hubWithNode();
    const p = hub.dispatch('n1', 'service.deploy', { spec: { name: 'web', image: 'big' } }, { timeoutMs: 40 });
    const id = sent[0]!.payload.commandId;
    hub.commandProgress(id, { phase: 'pulling', message: 'pulling image big…' });
    expect(hub.deployProgress('org1', 'web')).toMatchObject({ phase: 'pulling', message: 'pulling image big…' });
    await Bun.sleep(80); // past the 40ms base budget — the heartbeat re-armed it
    hub.settleCommand(id, true, { serviceId: 's1', created: false });
    expect(await p).toEqual({ serviceId: 's1', created: false });
    expect(hub.deployProgress('org1', 'web')).toBeUndefined();
  });

  it('without progress the base timeout still applies', async () => {
    const { hub } = hubWithNode();
    await expect(
      hub.dispatch('n1', 'service.deploy', { spec: { name: 'web', image: 'x' } }, { timeoutMs: 20 }),
    ).rejects.toThrow('command timeout');
  });
});
