import { describe, expect, test } from 'bun:test';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { ControllerToAgentMessage } from './messages';
import { ReimageMeshMsg, ReimageMeshPayload, ReimageMeshResult } from './mesh-reimage';

const CMD = '55555555-5555-4555-8555-555555555555';
const IMAGE = `ghcr.io/netbirdio/netbird:0.80.0@sha256:${'a'.repeat(64)}`;

describe('reimageMesh wire shape (the upgrade mesh step)', () => {
  test('a minimal payload gives the new client 90 s to reconnect; the mirror hint is optional', () => {
    expect(ReimageMeshPayload.parse({ commandId: CMD, image: IMAGE })).toEqual({ commandId: CMD, image: IMAGE, reconnectTimeoutMs: 90_000 });
    const hinted = ReimageMeshPayload.parse({
      commandId: CMD,
      image: IMAGE,
      mirrorImage: 'reg:5000/swarmy-system/x@sha256:1',
      registryAuth: { username: 'u', password: 'p' },
    });
    expect(hinted.mirrorImage).toBe('reg:5000/swarmy-system/x@sha256:1');
  });

  test('refuses a payload without an image, a bad command id, or an unbounded wait', () => {
    expect(ReimageMeshPayload.safeParse({ commandId: CMD }).success).toBe(false);
    expect(ReimageMeshPayload.safeParse({ commandId: CMD, image: '' }).success).toBe(false);
    expect(ReimageMeshPayload.safeParse({ commandId: 'nope', image: IMAGE }).success).toBe(false);
    expect(ReimageMeshPayload.safeParse({ commandId: CMD, image: IMAGE, reconnectTimeoutMs: 3_600_000 }).success).toBe(false);
  });

  test('round-trips inside its message and the controller→agent union; a wrong type is refused', () => {
    const msg = { type: 'reimageMesh' as const, payload: { commandId: CMD, image: IMAGE } };
    const parsed = ReimageMeshMsg.parse(JSON.parse(JSON.stringify(msg)));
    expect(ReimageMeshMsg.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(ControllerToAgentMessage.safeParse(msg).success).toBe(true);
    expect(ReimageMeshMsg.safeParse({ ...msg, type: 'applyMesh' }).success).toBe(false);
  });

  test('the result says whether anything changed and why not', () => {
    expect(ReimageMeshResult.safeParse({ changed: true, from: 'a', to: IMAGE, meshIp: '100.64.0.2' }).success).toBe(true);
    expect(ReimageMeshResult.safeParse({ changed: false, reason: 'no-client' }).success).toBe(true);
    expect(ReimageMeshResult.safeParse({ changed: false, reason: 'gone' }).success).toBe(false);
  });

  test('is an additive command: advertised as a capability, never assumed of an older agent', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.reimageMesh);
    expect(agentSupports(['dbPitrWindow'], 'reimageMesh')).toBe(false);
    expect(agentSupports(undefined, 'reimageMesh')).toBe(false);
  });
});
