import { describe, expect, it } from 'bun:test';
import {
  SwarmJoinPayload,
  SwarmJoinMsg,
  SwarmJoinResult,
  SWARM_JOIN_TIMEOUT_MS,
} from './swarm';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

describe('SwarmJoinPayload', () => {
  it('accepts a minimal init payload', () => {
    const r = SwarmJoinPayload.safeParse({ commandId: CMD_ID, mode: 'init' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBe('worker'); // defaulted
  });

  it('accepts an init with advertiseAddr', () => {
    const r = SwarmJoinPayload.safeParse({ commandId: CMD_ID, mode: 'init', advertiseAddr: '10.0.0.2' });
    expect(r.success).toBe(true);
  });

  it('requires joinToken + managerAddr for join mode', () => {
    const missing = SwarmJoinPayload.safeParse({ commandId: CMD_ID, mode: 'join' });
    expect(missing.success).toBe(false);

    const partial = SwarmJoinPayload.safeParse({ commandId: CMD_ID, mode: 'join', joinToken: 'SWMTKN-x' });
    expect(partial.success).toBe(false);

    const ok = SwarmJoinPayload.safeParse({
      commandId: CMD_ID,
      mode: 'join',
      joinToken: 'SWMTKN-x',
      managerAddr: '10.0.0.2:2377',
      role: 'manager',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.role).toBe('manager');
  });

  it('rejects an unknown mode', () => {
    const r = SwarmJoinPayload.safeParse({ commandId: CMD_ID, mode: 'leave' });
    expect(r.success).toBe(false);
  });
});

describe('SwarmJoinMsg', () => {
  it('wraps the payload with the swarmJoin discriminant', () => {
    const r = SwarmJoinMsg.safeParse({
      type: 'swarmJoin',
      payload: { commandId: CMD_ID, mode: 'init' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a wrong type literal', () => {
    const r = SwarmJoinMsg.safeParse({ type: 'swarmInit', payload: { commandId: CMD_ID, mode: 'init' } });
    expect(r.success).toBe(false);
  });
});

describe('SwarmJoinResult', () => {
  it('validates an init result carrying join tokens', () => {
    const r = SwarmJoinResult.safeParse({
      mode: 'init',
      swarmNodeId: 'n1',
      managerAddr: '10.0.0.2:2377',
      joinTokens: { worker: 'SWMTKN-w', manager: 'SWMTKN-m' },
    });
    expect(r.success).toBe(true);
  });

  it('validates a minimal join result', () => {
    const r = SwarmJoinResult.safeParse({ mode: 'join', swarmNodeId: 'n2' });
    expect(r.success).toBe(true);
  });
});

describe('SWARM_JOIN_TIMEOUT_MS', () => {
  it('is a sane positive timeout', () => {
    expect(SWARM_JOIN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
