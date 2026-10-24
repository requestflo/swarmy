import { describe, expect, it } from 'bun:test';
import { MeshStatePayload } from '@swarmy/core/protocol';
import { parseTailscaleStatus, tailscalePeerRelayed } from './mesh-tailscale';

const status = (peers: Record<string, object>) =>
  JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], Online: true }, Peer: peers });

describe('Headscale (tailscale client) relayed state', () => {
  it('per peer, as `tailscale status` prints it: direct CurAddr, else DERP / peer relay; idle = unknown', () => {
    expect(tailscalePeerRelayed({ Active: true, CurAddr: '203.0.113.7:41641', Relay: 'lhr' })).toBe(false);
    expect(tailscalePeerRelayed({ Active: true, CurAddr: '', Relay: 'lhr' })).toBe(true);
    expect(tailscalePeerRelayed({ Active: true, PeerRelay: '100.64.0.9:7777' })).toBe(true);
    expect(tailscalePeerRelayed({ Active: false, CurAddr: '', Relay: 'lhr' })).toBeUndefined();
  });

  it('one relayed active link makes the node relayed; all-direct is direct', () => {
    const relayed = parseTailscaleStatus(
      status({
        a: { TailscaleIPs: ['100.64.0.2'], Online: true, Active: true, CurAddr: '198.51.100.4:41641', Relay: 'lhr' },
        b: { TailscaleIPs: ['100.64.0.3'], Online: true, Active: true, CurAddr: '', Relay: 'nyc' },
      }),
      5,
    );
    expect(relayed.relayed).toBe(true);
    expect(relayed.peers).toEqual([
      { meshIp: '100.64.0.2', connected: true, relayed: false },
      { meshIp: '100.64.0.3', connected: true, relayed: true },
    ]);
    const direct = parseTailscaleStatus(status({ a: { Online: true, Active: true, CurAddr: '198.51.100.4:41641' } }), 5);
    expect(direct.relayed).toBe(false);
  });

  it('no active peer → relayed left out (unknown), never a guess; the frame still parses', () => {
    const idle = parseTailscaleStatus(status({ a: { TailscaleIPs: ['100.64.0.2'], Online: true, Active: false, Relay: 'lhr' } }), 5);
    expect('relayed' in idle).toBe(false);
    expect(idle).toMatchObject({ driver: 'headscale', meshIp: '100.64.0.1', connected: true });
    expect(MeshStatePayload.parse(idle).relayed).toBeUndefined();
    expect('relayed' in parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Peer: null }), 5)).toBe(false);
  });
});
