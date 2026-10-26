import { describe, expect, it } from 'bun:test';
import {
  durationNsToMs,
  goTime,
  netbirdPeerLinks,
  netbirdRelayed,
  nodeRelayed,
  tailscalePeerLinks,
  tailscalePeerRelayed,
} from './link-facts';

/** `netbird status --json` as v0.79 prints it (client/status/status.go), trimmed to three peers. */
const NETBIRD = {
  peers: {
    total: 3,
    connected: 2,
    details: [
      {
        fqdn: 'home-lab.netbird.selfhosted', netbirdIp: '100.92.4.20', publicKey: 'Fy1x+home=', status: 'Connected',
        lastStatusUpdate: '2026-10-26T10:41:01.52Z', connectionType: 'P2P',
        iceCandidateType: { local: 'host', remote: 'srflx' }, iceCandidateEndpoint: { local: '10.0.1.11:51820', remote: '203.0.113.7:51820' },
        relayAddress: '', lastWireguardHandshake: '2026-10-26T11:41:58.123+01:00',
        transferReceived: 1288490188, transferSent: 356515840, latency: 412345, quantumResistance: false, networks: [],
      },
      {
        fqdn: 'london-2.netbird.selfhosted', netbirdIp: '100.92.4.2', publicKey: 'Qz9+lon2=', status: 'Connected',
        lastStatusUpdate: '2026-10-26T10:40:12Z', connectionType: 'Relayed',
        iceCandidateType: { local: '', remote: '' }, iceCandidateEndpoint: { local: '', remote: '' },
        relayAddress: 'rels://relay.203-0-113-9.northwind.dev:443', lastWireguardHandshake: '2026-10-26T10:41:40Z',
        transferReceived: 52428800, transferSent: 0, latency: 19060000, quantumResistance: false, networks: [],
      },
      {
        fqdn: 'pi-garage.netbird.selfhosted', netbirdIp: '100.92.4.30', publicKey: 'Pi4+gar=', status: 'Idle',
        lastStatusUpdate: '2026-10-26T09:00:00Z', connectionType: '-',
        iceCandidateType: { local: '', remote: '' }, iceCandidateEndpoint: { local: '', remote: '' },
        relayAddress: '', lastWireguardHandshake: '0001-01-01T00:00:00Z',
        transferReceived: 0, transferSent: 0, latency: 0, quantumResistance: false, networks: [],
      },
    ],
  },
  cliVersion: '0.79.0',
  daemonVersion: '0.79.0',
  management: { url: 'https://mesh.northwind.dev:443', connected: true, error: '' },
  netbirdIp: '100.92.4.1/16',
  publicKey: 'Ab3+lon1=',
  usesKernelInterface: true,
  fqdn: 'london-1.netbird.selfhosted',
};

/** `tailscale status --json` (ipn/ipnstate.Status) from Headscale's client, three peers. */
const TAILSCALE = {
  Version: '1.104.2-t1234abcd',
  BackendState: 'Running',
  TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
  Self: { HostName: 'london-1', TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], Online: true },
  Peer: {
    'nodekey:aa11': {
      ID: 'n1CNTRL', PublicKey: 'nodekey:aa11', HostName: 'home-lab', TailscaleIPs: ['fd7a:115c:a1e0::2', '100.64.0.2'],
      Addrs: ['203.0.113.7:41641'], CurAddr: '203.0.113.7:41641', Relay: 'lhr', PeerRelay: '',
      RxBytes: 734003, TxBytes: 91234, LastHandshake: '2026-10-26T10:41:30.5Z', Online: true, Active: true,
    },
    'nodekey:bb22': {
      ID: 'n2CNTRL', PublicKey: 'nodekey:bb22', HostName: 'london-2', TailscaleIPs: ['100.64.0.3'],
      Addrs: null, CurAddr: '', Relay: 'lhr', PeerRelay: '', RxBytes: 1024, TxBytes: 2048,
      LastHandshake: '2026-10-26T10:41:10Z', Online: true, Active: true,
    },
    'nodekey:cc33': {
      ID: 'n3CNTRL', PublicKey: 'nodekey:cc33', HostName: 'pi-garage', TailscaleIPs: ['100.64.0.4'],
      CurAddr: '', Relay: 'lhr', RxBytes: 0, TxBytes: 0, LastHandshake: '0001-01-01T00:00:00Z', Online: false, Active: false,
    },
  },
};

describe('NetBird per-peer link facts (`netbird status --json`)', () => {
  it('reads latency (ns → ms), the connection type and bytes for each connected peer', () => {
    expect(netbirdPeerLinks(NETBIRD)).toEqual([
      {
        meshIp: '100.92.4.20', publicKey: 'Fy1x+home=', connected: true, lastHandshakeAt: '2026-10-26T10:41:58.123Z',
        link: { latencyMs: 0.412, relayed: false, rxBytes: 1288490188, txBytes: 356515840 },
      },
      {
        meshIp: '100.92.4.2', publicKey: 'Qz9+lon2=', connected: true, lastHandshakeAt: '2026-10-26T10:41:40.000Z',
        link: { latencyMs: 19.06, relayed: true, rxBytes: 52428800, txBytes: 0 },
      },
      // Not connected: the client fills nothing for it, so there are no link facts (never zeros).
      { meshIp: '100.92.4.30', publicKey: 'Pi4+gar=', connected: false },
    ]);
  });

  it('a connected peer the client has not measured yet leaves latency out', () => {
    const [p] = netbirdPeerLinks({ peers: { details: [{ netbirdIp: '100.92.4.5', status: 'Connected', connectionType: 'P2P', latency: 0 }] } });
    expect(p?.link).toEqual({ relayed: false });
  });

  it('connection type: P2P is direct, Relayed is relayed, "-" and anything new are unknown', () => {
    expect(netbirdRelayed('P2P')).toBe(false);
    expect(netbirdRelayed('Relayed')).toBe(true);
    expect(netbirdRelayed('-')).toBeUndefined();
    expect(netbirdRelayed('Turn')).toBeUndefined();
  });

  it('survives an empty or odd status', () => {
    expect(netbirdPeerLinks({})).toEqual([]);
    expect(netbirdPeerLinks(null)).toEqual([]);
    expect(netbirdPeerLinks({ peers: { details: null } })).toEqual([]);
    expect(netbirdPeerLinks({ peers: { details: [{ status: 'Connected', latency: 'fast', transferSent: -1 }] } })).toEqual([
      { meshIp: undefined, publicKey: undefined, connected: true, link: {} },
    ]);
  });
});

describe('Tailscale per-peer link facts (`tailscale status --json`)', () => {
  it('reads the path and bytes per online peer; no latency (status carries none)', () => {
    expect(tailscalePeerLinks(TAILSCALE)).toEqual([
      {
        meshIp: '100.64.0.2', publicKey: 'nodekey:aa11', connected: true, lastHandshakeAt: '2026-10-26T10:41:30.500Z',
        link: { relayed: false, rxBytes: 734003, txBytes: 91234 },
      },
      {
        meshIp: '100.64.0.3', publicKey: 'nodekey:bb22', connected: true, lastHandshakeAt: '2026-10-26T10:41:10.000Z',
        link: { relayed: true, rxBytes: 1024, txBytes: 2048 },
      },
      { meshIp: '100.64.0.4', publicKey: 'nodekey:cc33', connected: false },
    ]);
    expect(tailscalePeerLinks({ BackendState: 'Running', Peer: null })).toEqual([]);
  });

  it('relayed per peer: a direct CurAddr, else DERP / a peer relay; idle = unknown', () => {
    expect(tailscalePeerRelayed({ Active: true, CurAddr: '203.0.113.7:41641', Relay: 'lhr' })).toBe(false);
    expect(tailscalePeerRelayed({ Active: true, CurAddr: '', Relay: 'lhr' })).toBe(true);
    expect(tailscalePeerRelayed({ Active: true, PeerRelay: '100.64.0.9:7777' })).toBe(true);
    expect(tailscalePeerRelayed({ Active: false, CurAddr: '', Relay: 'lhr' })).toBeUndefined();
  });
});

describe('helpers', () => {
  it('a Go duration of 0 is "not measured"; a Go zero time is "never"', () => {
    expect(durationNsToMs(11_234_567)).toBe(11.235);
    expect(durationNsToMs(0)).toBeUndefined();
    expect(durationNsToMs(-5)).toBeUndefined();
    expect(goTime('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(goTime('0000-12-31T23:58:45-00:01')).toBeUndefined();
    expect(goTime('2026-10-26T11:00:00+01:00')).toBe('2026-10-26T10:00:00.000Z');
    expect(goTime('soon')).toBeUndefined();
  });

  it('the node is relayed when any link is, direct when all known are, unknown with none known', () => {
    expect(nodeRelayed(netbirdPeerLinks(NETBIRD))).toBe(true);
    expect(nodeRelayed([{ connected: true, link: { relayed: false } }, { connected: false }])).toBe(false);
    expect(nodeRelayed([{ connected: true, link: { rxBytes: 4 } }, { connected: false }])).toBeUndefined();
  });
});
