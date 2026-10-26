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

describe('a dispatcher hears its own command\'s progress', () => {
  it('onProgress gets each restore frame, and none after the command settled', async () => {
    const { hub, sent } = hubWithNode();
    const heard: unknown[] = [];
    const p = hub.dispatch('n1', 'db.restore', { mode: 'pitr' }, { onProgress: (x) => heard.push(x) });
    const id = sent[0]!.payload.commandId;
    hub.commandProgress(id, { phase: 'restoring', restore: { stage: 'base', bytesDone: 10, bytesTotal: 40 } });
    hub.commandProgress(id, { phase: 'restoring', restore: { stage: 'wal', segments: 16 } });
    expect(heard).toEqual([
      { phase: 'restoring', restore: { stage: 'base', bytesDone: 10, bytesTotal: 40 } },
      { phase: 'restoring', restore: { stage: 'wal', segments: 16 } },
    ]);
    hub.settleCommand(id, true, { mode: 'pitr' });
    await p;
    hub.commandProgress(id, { phase: 'restoring', restore: { stage: 'wal', segments: 32 } });
    expect(heard).toHaveLength(2);
  });

  it('a listener that throws never fails the command', async () => {
    const { hub, sent } = hubWithNode();
    const p = hub.dispatch('n1', 'db.restore', {}, { onProgress: () => { throw new Error('boom'); } });
    const id = sent[0]!.payload.commandId;
    hub.commandProgress(id, { phase: 'restoring', restore: { stage: 'download' } });
    hub.settleCommand(id, true, { ok: 1 });
    expect(await p).toEqual({ ok: 1 });
  });
});
