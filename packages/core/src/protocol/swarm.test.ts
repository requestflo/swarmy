import { describe, expect, it } from 'bun:test';
import {
  SwarmJoinPayload,
  SwarmJoinMsg,
  SwarmJoinResult,
  SwarmRotateTokensMsg,
  SwarmRotateTokensPayload,
  SwarmRotateTokensResult,
  SwarmSetAutolockMsg,
  SwarmSetAutolockPayload,
  SwarmSetAutolockResult,
  SWARM_JOIN_TIMEOUT_MS,
} from './swarm';
import { UpdateSwarmNodePayload } from './commands';
import { ControllerToAgentMessage } from './messages';

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

describe('SwarmSetAutolockPayload (WS2)', () => {
  it('accepts enable and disable', () => {
    expect(SwarmSetAutolockPayload.safeParse({ commandId: CMD_ID, enabled: true }).success).toBe(true);
    expect(SwarmSetAutolockPayload.safeParse({ commandId: CMD_ID, enabled: false }).success).toBe(true);
  });

  it('rejects a missing or non-boolean enabled', () => {
    expect(SwarmSetAutolockPayload.safeParse({ commandId: CMD_ID }).success).toBe(false);
    expect(SwarmSetAutolockPayload.safeParse({ commandId: CMD_ID, enabled: 'yes' }).success).toBe(false);
  });

  it('wraps with the swarmSetAutolock discriminant and rejects a wrong type', () => {
    const ok = SwarmSetAutolockMsg.safeParse({
      type: 'swarmSetAutolock',
      payload: { commandId: CMD_ID, enabled: true },
    });
    expect(ok.success).toBe(true);
    const wrong = SwarmSetAutolockMsg.safeParse({
      type: 'swarmAutolock',
      payload: { commandId: CMD_ID, enabled: true },
    });
    expect(wrong.success).toBe(false);
  });

  it('round-trips through the ControllerToAgentMessage union', () => {
    const r = ControllerToAgentMessage.safeParse({
      type: 'swarmSetAutolock',
      payload: { commandId: CMD_ID, enabled: true },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'swarmSetAutolock') {
      expect(r.data.payload.enabled).toBe(true);
    }
  });
});

describe('SwarmSetAutolockResult (WS2)', () => {
  it('carries the unlock key only on enable', () => {
    expect(
      SwarmSetAutolockResult.safeParse({ autolock: true, unlockKey: 'SWMKEY-1-abc' }).success,
    ).toBe(true);
    expect(SwarmSetAutolockResult.safeParse({ autolock: false }).success).toBe(true);
    expect(SwarmSetAutolockResult.safeParse({ autolock: true, unlockKey: '' }).success).toBe(false);
  });
});

describe('SwarmRotateTokensPayload (WS2)', () => {
  it('accepts one or both roles', () => {
    expect(SwarmRotateTokensPayload.safeParse({ commandId: CMD_ID, roles: ['worker'] }).success).toBe(true);
    expect(
      SwarmRotateTokensPayload.safeParse({ commandId: CMD_ID, roles: ['manager', 'worker'] }).success,
    ).toBe(true);
  });

  it('rejects an empty or unknown role list', () => {
    expect(SwarmRotateTokensPayload.safeParse({ commandId: CMD_ID, roles: [] }).success).toBe(false);
    expect(SwarmRotateTokensPayload.safeParse({ commandId: CMD_ID, roles: ['leader'] }).success).toBe(false);
    expect(SwarmRotateTokensPayload.safeParse({ commandId: CMD_ID }).success).toBe(false);
  });

  it('wraps with the swarmRotateTokens discriminant and joins the union', () => {
    const msg = { type: 'swarmRotateTokens', payload: { commandId: CMD_ID, roles: ['manager'] } };
    expect(SwarmRotateTokensMsg.safeParse(msg).success).toBe(true);
    expect(ControllerToAgentMessage.safeParse(msg).success).toBe(true);
    expect(
      SwarmRotateTokensMsg.safeParse({ ...msg, type: 'rotateTokens' }).success,
    ).toBe(false);
  });
});

describe('SwarmRotateTokensResult (WS2)', () => {
  it('carries the post-rotation token pair', () => {
    const r = SwarmRotateTokensResult.safeParse({
      joinTokens: { worker: 'SWMTKN-w2', manager: 'SWMTKN-m2' },
    });
    expect(r.success).toBe(true);
    expect(SwarmRotateTokensResult.safeParse({}).success).toBe(false);
  });
});

describe('UpdateSwarmNodePayload role extension (WS2 promote/demote)', () => {
  it('stays valid without a role (additive change)', () => {
    const r = UpdateSwarmNodePayload.safeParse({ commandId: CMD_ID, swarmNodeId: 'n1', availability: 'drain' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBeUndefined();
  });

  it('accepts manager/worker and rejects anything else', () => {
    expect(
      UpdateSwarmNodePayload.safeParse({ commandId: CMD_ID, swarmNodeId: 'n1', role: 'manager' }).success,
    ).toBe(true);
    expect(
      UpdateSwarmNodePayload.safeParse({ commandId: CMD_ID, swarmNodeId: 'n1', role: 'worker' }).success,
    ).toBe(true);
    expect(
      UpdateSwarmNodePayload.safeParse({ commandId: CMD_ID, swarmNodeId: 'n1', role: 'leader' }).success,
    ).toBe(false);
  });
});
