import { describe, expect, test } from 'bun:test';
import { MeshPeerStore, reconcileMeshPeer } from './mesh-peers';

describe('reconcileMeshPeer (live peer map, no table)', () => {
  test('a connected report with an IP creates the peer as CONNECTED', () => {
    const store = new MeshPeerStore();
    const peer = reconcileMeshPeer(
      'org-1',
      'node-1',
      {
        driver: 'netbird',
        connected: true,
        meshIp: '100.64.0.4',
        peerId: 'peer-9',
        lastHandshakeAt: '2026-06-27T12:00:00.000Z',
        sampledAt: Date.now(),
      },
      store,
    );
    expect(peer?.status).toBe('CONNECTED');
    expect(store.get('node-1')).toMatchObject({ orgId: 'org-1', meshIp: '100.64.0.4', peerId: 'peer-9' });
    expect(store.forOrg('org-1')).toHaveLength(1);
    expect(store.forOrg('org-2')).toHaveLength(0);
  });

  test('a report for an unknown, unconnected node is a no-op', () => {
    const store = new MeshPeerStore();
    expect(reconcileMeshPeer('org-1', 'node-2', { driver: 'wireguard', connected: false, sampledAt: Date.now() }, store)).toBeNull();
    expect(store.get('node-2')).toBeUndefined();
  });

  test('an errored report on a known peer maps to FAILED and keeps its last IP', () => {
    const store = new MeshPeerStore();
    store.upsert('org-1', 'node-3', { driver: 'wireguard', status: 'CONNECTED', meshIp: '10.9.0.3' });
    reconcileMeshPeer('org-1', 'node-3', { driver: 'wireguard', connected: false, error: 'wg down', sampledAt: Date.now() }, store);
    expect(store.get('node-3')).toMatchObject({ status: 'FAILED', meshIp: '10.9.0.3' });
  });

  test('relayed passes through from the agent and survives a control-plane refresh', () => {
    const store = new MeshPeerStore();
    const report = { driver: 'netbird', connected: true, meshIp: '100.64.0.7', sampledAt: Date.now() };
    reconcileMeshPeer('org-1', 'node-4', { ...report, relayed: true }, store);
    expect(store.get('node-4')?.relayed).toBe(true);
    // The control plane doesn't know relay state: an upsert without it keeps the agent's.
    store.upsert('org-1', 'node-4', { status: 'CONNECTED', lastSeen: new Date() });
    expect(store.get('node-4')?.relayed).toBe(true);
    reconcileMeshPeer('org-1', 'node-4', { ...report, relayed: false }, store);
    expect(store.get('node-4')?.relayed).toBe(false);
  });

  test('relayed is unknown (null) until an agent reports it', () => {
    const store = new MeshPeerStore();
    store.upsert('org-1', 'node-5', { status: 'CONNECTED', meshIp: '100.64.0.8' });
    reconcileMeshPeer('org-1', 'node-5', { driver: 'netbird', connected: true, sampledAt: Date.now() }, store);
    expect(store.get('node-5')?.relayed).toBeNull();
  });
});
