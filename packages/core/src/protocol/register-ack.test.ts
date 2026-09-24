import { describe, expect, it } from 'bun:test';
import { RegisterAckMsg } from './auth';

const base = {
  nodeId: 'node_1',
  sessionCredential: { sessionSecret: 'sess_x', sessionVersion: 3 },
  negotiatedVersion: 1,
  heartbeatIntervalMs: 15000,
  metricsIntervalMs: 30000,
  serverTime: 1_700_000_000_000,
};

describe('registerAck observedPublicIp (B8)', () => {
  it('round-trips the observed public IP', () => {
    const msg = { type: 'registerAck' as const, payload: { ...base, observedPublicIp: '203.0.113.7' } };
    expect(RegisterAckMsg.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });
  it('stays optional (older controllers omit it)', () => {
    const parsed = RegisterAckMsg.parse({ type: 'registerAck', payload: base });
    expect(parsed.payload.observedPublicIp).toBeUndefined();
  });
});
