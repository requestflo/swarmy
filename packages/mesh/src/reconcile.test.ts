import { describe, expect, test } from 'bun:test';
import { reconcilePeerState, reconcileFromControlPlane } from './reconcile';

describe('reconcilePeerState', () => {
  test('connected → CONNECTED, uses lastHandshakeAt', () => {
    const u = reconcilePeerState({
      driver: 'netbird',
      connected: true,
      meshIp: '100.64.0.3',
      peerId: 'peer-1',
      lastHandshakeAt: '2026-06-27T10:00:00.000Z',
      sampledAt: 1_750_000_000_000,
    });
    expect(u.status).toBe('CONNECTED');
    expect(u.meshIp).toBe('100.64.0.3');
    expect(u.peerId).toBe('peer-1');
    expect(u.lastSeen.toISOString()).toBe('2026-06-27T10:00:00.000Z');
  });

  test('disconnected (no error) → DEGRADED, falls back to sampledAt', () => {
    const u = reconcilePeerState({ driver: 'netbird', connected: false, sampledAt: 1_700_000_000_000 });
    expect(u.status).toBe('DEGRADED');
    expect(u.meshIp).toBeNull();
    expect(u.lastSeen.getTime()).toBe(1_700_000_000_000);
  });

  test('error → FAILED regardless of connected', () => {
    const u = reconcilePeerState({
      driver: 'wireguard',
      connected: true,
      error: 'wg show failed',
      sampledAt: 1,
    });
    expect(u.status).toBe('FAILED');
  });
});

describe('reconcileFromControlPlane', () => {
  test('maps a control-plane peer listing', () => {
    expect(reconcileFromControlPlane({ peerId: 'p', connected: true, meshIp: '100.64.0.9' }).status).toBe(
      'CONNECTED',
    );
    expect(reconcileFromControlPlane({ peerId: 'p', connected: false }).status).toBe('DEGRADED');
  });
});
