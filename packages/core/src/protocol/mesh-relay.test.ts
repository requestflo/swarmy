import { describe, expect, test } from 'bun:test';
import { ControllerToAgentMessage } from './messages';
import { MeshStatePayload } from './mesh';
import { ApplyMeshRelayMsg, ApplyMeshRelayPayload, MeshRelaySpec, meshRelaySpecHash } from './mesh-relay';

const CMD = '44444444-4444-4444-8444-444444444444';
const spec = { image: 'ghcr.io/netbirdio/relay:0.79.0', exposedAddress: 'rels://relay.1-2-3-4.sslip.io:443', authSecret: 'relay-secret-0123456789' };

describe('applyMeshRelay wire shape (relays on edges)', () => {
  test('a minimal spec fills the ports and STUN defaults', () => {
    expect(MeshRelaySpec.parse(spec)).toEqual({
      ...spec,
      listenPort: 33080,
      healthPort: 33081,
      metricsPort: 33082,
      stun: true,
      stunPort: 3478,
    });
    expect(ApplyMeshRelayPayload.parse({ commandId: CMD }).action).toBe('apply');
  });

  test('round-trips inside its message and the controller→agent union', () => {
    const msg = { type: 'applyMeshRelay' as const, payload: { commandId: CMD, spec } };
    const parsed = ApplyMeshRelayMsg.parse(JSON.parse(JSON.stringify(msg)));
    expect(ApplyMeshRelayMsg.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(ControllerToAgentMessage.safeParse(msg).success).toBe(true);
    expect(ApplyMeshRelayMsg.safeParse({ ...msg, type: 'applyMeshControl' }).success).toBe(false);
  });

  test('refuses what could break out of the env file or the listener', () => {
    const bad = (patch: Record<string, unknown>) => MeshRelaySpec.safeParse({ ...spec, ...patch }).success;
    expect(bad({ exposedAddress: "rels://x:443' ; rm -rf /" })).toBe(false);
    expect(bad({ exposedAddress: 'https://relay.x:443' })).toBe(false);
    expect(bad({ authSecret: 'short' })).toBe(false);
    expect(bad({ authSecret: 'line-one-0123456789\nNB_X=1' })).toBe(false);
    expect(bad({ listenPort: 0 })).toBe(false);
    expect(ApplyMeshRelayPayload.safeParse({ commandId: CMD, action: 'nuke' }).success).toBe(false);
  });

  test('the spec hash is stable under defaults and key order, and moves with any field', () => {
    const a = meshRelaySpecHash(MeshRelaySpec.parse(spec));
    expect(meshRelaySpecHash({ ...MeshRelaySpec.parse(spec) })).toBe(a);
    const reordered = MeshRelaySpec.parse({ authSecret: spec.authSecret, exposedAddress: spec.exposedAddress, image: spec.image });
    expect(meshRelaySpecHash(reordered)).toBe(a);
    expect(meshRelaySpecHash(MeshRelaySpec.parse({ ...spec, stun: false }))).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('meshState.relay is optional (older agents omit it)', () => {
    const base = { driver: 'netbird', connected: true, sampledAt: 1 };
    expect(MeshStatePayload.parse(base).relay).toBeUndefined();
    expect(MeshStatePayload.parse({ ...base, relay: { running: true, healthy: false, stun: false } }).relay).toEqual({
      running: true,
      healthy: false,
      stun: false,
    });
  });
});
