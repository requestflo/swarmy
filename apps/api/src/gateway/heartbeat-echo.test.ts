import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { handleAgentMessage } from './protocol-handlers';
import { GatewayStore } from './store';

describe('controller echoes a ping for every agent heartbeat (agent dead-link detection)', () => {
  it('replies ping hb-<seq> and records lastSeen', async () => {
    const sent: string[] = [];
    const ws = { data: { state: 'ready', nodeId: 'n1' }, send: (s: string) => sent.push(s), close: () => undefined } as never;
    const store = new GatewayStore();
    const raw = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'heartbeat',
      payload: { seq: 7, uptimeSec: 1, inflightCommands: 0 },
    });
    await handleAgentMessage(ws, raw, { hub: {} as never, store, registry: {} as never });
    expect(store.lastSeen.get('n1')).toBeGreaterThan(0);
    const frame = JSON.parse(sent[0]!);
    expect(frame).toMatchObject({ type: 'ping', payload: { nonce: 'hb-7' } });
  });
});
