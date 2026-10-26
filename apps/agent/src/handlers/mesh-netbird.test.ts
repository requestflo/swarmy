import { describe, expect, it } from 'bun:test';
import { MeshStatePayload } from '@swarmy/core/protocol';
import { parseNetbirdStatus } from './mesh-netbird';

/** One peer of `netbird status --json` (v0.79 field names). */
const peer = (ip: string, status: string, connectionType: string, latency: number, rx = 0, tx = 0) => ({
  fqdn: `${ip}.netbird.selfhosted`,
  netbirdIp: ip,
  publicKey: `key-${ip}`,
  status,
  connectionType,
  latency,
  transferReceived: rx,
  transferSent: tx,
  lastWireguardHandshake: status === 'Connected' ? '2026-10-26T10:41:58Z' : '0001-01-01T00:00:00Z',
  iceCandidateType: { local: '', remote: '' },
  relayAddress: '',
  quantumResistance: false,
  networks: [],
});
const status = (details: object[], extra: object = {}): string =>
  JSON.stringify({
    peers: { total: details.length, connected: 0, details },
    management: { url: 'https://mesh.northwind.dev:443', connected: true, error: '' },
    netbirdIp: '100.92.4.1/16',
    ...extra,
  });

describe('NetBird status → meshState', () => {
  it('reads each peer by its real field names (netbirdIp, connectionType) with its link facts', () => {
    const { state, cidr } = parseNetbirdStatus(
      status([
        peer('100.92.4.20', 'Connected', 'P2P', 412_345, 1024, 2048),
        peer('100.92.4.2', 'Connected', 'Relayed', 19_060_000),
        peer('100.92.4.30', 'Idle', '-', 0),
      ]),
      7,
    );
    expect(cidr).toBe('100.92.4.1/16');
    expect(state).toMatchObject({ driver: 'netbird', meshIp: '100.92.4.1', connected: true, relayed: true, sampledAt: 7 });
    const at = '2026-10-26T10:41:58.000Z';
    expect(state.peers).toEqual([
      { meshIp: '100.92.4.20', publicKey: 'key-100.92.4.20', connected: true, relayed: false, lastHandshakeAt: at, link: { latencyMs: 0.412, relayed: false, rxBytes: 1024, txBytes: 2048 } },
      { meshIp: '100.92.4.2', publicKey: 'key-100.92.4.2', connected: true, relayed: true, lastHandshakeAt: at, link: { latencyMs: 19.06, relayed: true, rxBytes: 0, txBytes: 0 } },
      { meshIp: '100.92.4.30', publicKey: 'key-100.92.4.30', connected: false, relayed: false },
    ]);
    // A valid frame as sent.
    expect(MeshStatePayload.parse(state).peers[0]?.link?.latencyMs).toBe(0.412);
  });

  it('all P2P → direct; no connected peer → relayed left out (unknown), never "direct" on a guess', () => {
    expect(parseNetbirdStatus(status([peer('100.92.4.20', 'Connected', 'P2P', 1)]), 1).state.relayed).toBe(false);
    const idle = parseNetbirdStatus(status([peer('100.92.4.30', 'Idle', '-', 0)]), 1).state;
    expect('relayed' in idle).toBe(false);
    expect(MeshStatePayload.parse(idle).relayed).toBeUndefined();
  });

  it('a client not yet addressed reports no mesh IP (QA-063); bad JSON throws for the caller to report', () => {
    const { state, cidr } = parseNetbirdStatus(status([], { netbirdIp: '' }), 1);
    expect(state.meshIp).toBeUndefined();
    expect(cidr).toBeUndefined();
    expect(() => parseNetbirdStatus('not json', 1)).toThrow();
  });
});
