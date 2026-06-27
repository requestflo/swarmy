import { describe, expect, test } from 'bun:test';
import { reconcileMeshPeer, type MeshReconcileDb } from './mesh.service';

function fakeDb(): { db: MeshReconcileDb; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    db: {
      meshPeer: {
        async updateMany(args) {
          calls.push(args);
          return { count: 1 };
        },
      },
    },
  };
}

describe('reconcileMeshPeer', () => {
  test('persists a CONNECTED update from a live report', async () => {
    const { db, calls } = fakeDb();
    await reconcileMeshPeer(db, 'node-1', {
      driver: 'netbird',
      connected: true,
      meshIp: '100.64.0.4',
      peerId: 'peer-9',
      lastHandshakeAt: '2026-06-27T12:00:00.000Z',
      sampledAt: Date.now(),
    });
    expect(calls).toHaveLength(1);
    const arg = calls[0] as { where: { nodeId: string }; data: { status: string; meshIp: string | null } };
    expect(arg.where.nodeId).toBe('node-1');
    expect(arg.data.status).toBe('CONNECTED');
    expect(arg.data.meshIp).toBe('100.64.0.4');
  });

  test('maps an errored report to FAILED', async () => {
    const { db, calls } = fakeDb();
    await reconcileMeshPeer(db, 'node-2', {
      driver: 'wireguard',
      connected: false,
      error: 'wg down',
      sampledAt: Date.now(),
    });
    expect((calls[0] as { data: { status: string } }).data.status).toBe('FAILED');
  });
});
