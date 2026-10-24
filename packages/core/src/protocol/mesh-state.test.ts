import { describe, expect, it } from 'bun:test';
import { AgentToControllerMessage } from './messages';
import { MeshStatePayload, OverlayMtuSampleSchema } from './mesh';

const OLD = { driver: 'netbird', connected: true, meshIp: '100.92.0.4', relayed: false, advertisedRoutes: [], peers: [], sampledAt: 1 };

describe('meshState MTU fields (additive)', () => {
  it('an older agent (no MTU fields) still parses, with the fields absent', () => {
    const r = MeshStatePayload.safeParse(OLD);
    expect(r.success).toBe(true);
    expect(r.data?.interfaceMtu).toBeUndefined();
    expect(r.data?.overlays).toBeUndefined();
  });

  it('a newer agent reports the interface MTU and its overlays; sample defaults fill in', () => {
    const r = MeshStatePayload.safeParse({ ...OLD, interface: 'wt0', interfaceMtu: 1280, overlays: [{ name: 'shop_default' }, { name: 'swarmy', mtu: 1280, encrypted: true }] });
    expect(r.success).toBe(true);
    expect(r.data?.interfaceMtu).toBe(1280);
    expect(r.data?.overlays).toEqual([
      { name: 'shop_default', encrypted: false, attachable: false, managed: false, ingress: false },
      { name: 'swarmy', mtu: 1280, encrypted: true, attachable: false, managed: false, ingress: false },
    ]);
  });

  it('relayed may be absent (unknown: a Headscale node with no active link)', () => {
    const { relayed: _r, ...noRelay } = OLD;
    const r = MeshStatePayload.safeParse(noRelay);
    expect(r.success).toBe(true);
    expect(r.data?.relayed).toBeUndefined();
    expect(MeshStatePayload.parse(OLD).relayed).toBe(false);
  });

  it('rejects a non-positive or fractional MTU and a nameless overlay', () => {
    expect(MeshStatePayload.safeParse({ ...OLD, interfaceMtu: 0 }).success).toBe(false);
    expect(MeshStatePayload.safeParse({ ...OLD, interfaceMtu: 1280.5 }).success).toBe(false);
    expect(OverlayMtuSampleSchema.safeParse({ name: '' }).success).toBe(false);
    expect(OverlayMtuSampleSchema.safeParse({ name: 'x', mtu: -1 }).success).toBe(false);
  });

  it('rides the agent→controller union under its discriminant; a wrong type is refused', () => {
    const msg = AgentToControllerMessage.safeParse({ type: 'meshState', payload: { ...OLD, interfaceMtu: 1280, overlays: [] } });
    expect(msg.success).toBe(true);
    expect(msg.data?.type).toBe('meshState');
    expect(AgentToControllerMessage.safeParse({ type: 'meshStates', payload: OLD }).success).toBe(false);
  });
});
