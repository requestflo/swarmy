import { describe, expect, it } from 'bun:test';
import { AgentToControllerMessage, parseAgentEnvelope } from './messages';
import { MeshStatePayload } from './mesh';
import { MeshLinkFacts } from './mesh-link';
import { PROTOCOL_VERSION } from './constants';

const OLD = {
  driver: 'netbird',
  connected: true,
  meshIp: '100.92.4.1',
  relayed: false,
  advertisedRoutes: [],
  peers: [{ meshIp: '100.92.4.20', connected: true, relayed: false }],
  sampledAt: 1,
};
const LINKED = {
  ...OLD,
  peers: [
    { meshIp: '100.92.4.20', connected: true, relayed: false, link: { latencyMs: 0.412, relayed: false, rxBytes: 1288490188, txBytes: 356515840 } },
    { meshIp: '100.92.4.2', connected: true, relayed: true, link: { latencyMs: 19.06, relayed: true, rxBytes: 0, txBytes: 0 } },
    // Headscale: path and bytes, no latency.
    { meshIp: '100.64.0.3', connected: true, relayed: false, link: { relayed: false, rxBytes: 1024 } },
    { meshIp: '100.92.4.30', connected: false, relayed: false },
  ],
};

describe('meshState per-peer link facts (additive)', () => {
  it('an older agent (no link on any peer) still parses, with link absent', () => {
    const r = MeshStatePayload.safeParse(OLD);
    expect(r.success).toBe(true);
    expect(r.data?.peers[0]?.link).toBeUndefined();
  });

  it('a newer agent reports latency, path and bytes per peer; a partial link keeps its gaps', () => {
    const r = MeshStatePayload.parse(LINKED);
    expect(r.peers.map((p) => p.link)).toEqual([
      { latencyMs: 0.412, relayed: false, rxBytes: 1288490188, txBytes: 356515840 },
      { latencyMs: 19.06, relayed: true, rxBytes: 0, txBytes: 0 },
      { relayed: false, rxBytes: 1024 },
      undefined,
    ]);
    expect(MeshLinkFacts.parse({})).toEqual({});
  });

  it('rejects a negative or non-finite latency and fractional or negative bytes', () => {
    expect(MeshLinkFacts.safeParse({ latencyMs: -1 }).success).toBe(false);
    expect(MeshLinkFacts.safeParse({ latencyMs: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(MeshLinkFacts.safeParse({ rxBytes: 1.5 }).success).toBe(false);
    expect(MeshLinkFacts.safeParse({ txBytes: -2 }).success).toBe(false);
    expect(MeshLinkFacts.safeParse({ relayed: 'yes' }).success).toBe(false);
    expect(MeshStatePayload.safeParse({ ...OLD, peers: [{ connected: true, link: { latencyMs: '4ms' } }] }).success).toBe(false);
  });

  it('round-trips through the agent→controller envelope under its discriminant; a wrong type is refused', () => {
    const env = parseAgentEnvelope(JSON.parse(JSON.stringify({ v: PROTOCOL_VERSION, id: '00000000-0000-4000-8000-000000000001', ts: 1, type: 'meshState', payload: LINKED })));
    expect(env.type).toBe('meshState');
    expect(env.type === 'meshState' ? env.payload.peers[1]?.link : null).toEqual({ latencyMs: 19.06, relayed: true, rxBytes: 0, txBytes: 0 });
    expect(AgentToControllerMessage.safeParse({ type: 'meshLinks', payload: LINKED }).success).toBe(false);
  });
});
