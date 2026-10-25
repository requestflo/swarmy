import { describe, expect, test } from 'bun:test';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { DEFAULT_COMMAND_TIMEOUTS } from './constants';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';
import { RestartAgentMsg, RestartAgentPayload } from './restart-agent';

const CMD = '66666666-6666-4666-8666-666666666666';

describe('restartAgent wire shape (board 11 "Restart agent")', () => {
  test('a payload is just the command id (and an optional timeout)', () => {
    expect(RestartAgentPayload.parse({ commandId: CMD })).toEqual({ commandId: CMD });
    expect(RestartAgentPayload.parse({ commandId: CMD, timeoutMs: 15_000 }).timeoutMs).toBe(15_000);
  });

  test('refuses a bad command id or a non-positive timeout', () => {
    expect(RestartAgentPayload.safeParse({}).success).toBe(false);
    expect(RestartAgentPayload.safeParse({ commandId: 'nope' }).success).toBe(false);
    expect(RestartAgentPayload.safeParse({ commandId: CMD, timeoutMs: 0 }).success).toBe(false);
  });

  test('round-trips inside its message and the controller envelope; a wrong type is refused', () => {
    const msg = { type: 'restartAgent' as const, payload: { commandId: CMD } };
    const parsed = RestartAgentMsg.parse(JSON.parse(JSON.stringify(msg)));
    expect(RestartAgentMsg.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(ControllerToAgentMessage.safeParse(msg).success).toBe(true);
    const env = parseControllerEnvelope({ v: 1, id: CMD, ts: 1, ...msg });
    expect(env.type).toBe('restartAgent');
    expect(RestartAgentMsg.safeParse({ ...msg, type: 'updateAgent' }).success).toBe(false);
  });

  test('has a short default timeout: the agent answers before it exits', () => {
    expect(DEFAULT_COMMAND_TIMEOUTS.restartAgent).toBeLessThanOrEqual(30_000);
  });

  test('is an additive command: advertised as a capability, never assumed of an older agent', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.restartAgent);
    expect(agentSupports(['dbPitrWindow', 'reimageMesh'], 'restartAgent')).toBe(false);
    expect(agentSupports(undefined, 'restartAgent')).toBe(false);
  });
});
