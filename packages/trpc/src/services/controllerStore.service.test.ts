import { describe, expect, it } from 'bun:test';
import { toStoreView, type ControllerStoreRuntimeStatus } from './controllerStore.service';

const base: ControllerStoreRuntimeStatus = {
  role: 'leader',
  identity: { taskId: 't1', nodeId: 'n1', hostname: 'mgr-1', service: 'swarmy_controller' },
  lease: { holder: 't1', node: 'n1', epoch: 3, renewedAt: 0, ttlMs: 30000 },
  epoch: 3,
  leaseAgeMs: 4200,
  waitingFor: null,
  replica: { kind: 'garage', label: 'Garage (in-swarm)', endpoint: 'http://swarmy-garage:3900', bucket: 'swarmy-control', prefix: 'control' },
  replicating: true,
  replicationBlocked: null,
  litestream: { running: true, lastSyncAt: '2026-09-24T10:00:00.000Z', txid: '00000000000000aa', pendingWalBytes: 0, error: null, restarts: 0 },
  bundleConfigured: true,
  boot: { at: '2026-09-24T09:59:00.000Z', decision: { kind: 'restore-replica', reason: 'no local file' }, outcome: 'restored', durationMs: 900 },
  dbPath: '/var/lib/swarmy/data/control.db',
};
const now = Date.parse('2026-09-24T10:00:05.000Z');

describe('toStoreView', () => {
  it('caught up → lag 0, replicated mode, ~1 s loss window', () => {
    const v = toStoreView(base, [], now);
    expect(v).toMatchObject({ mode: 'replicated', lagSeconds: 0, epoch: 3, leaseRenewedAgoSec: 4, problem: null });
    expect(v.lossWindow).toContain('1 second');
    expect(v.boot?.kind).toBe('restore-replica');
  });
  it('pending WAL → lag is the time since the last successful sync', () => {
    const v = toStoreView({ ...base, litestream: { ...base.litestream!, pendingWalBytes: 4096 } }, [], now);
    expect(v.lagSeconds).toBe(5);
  });
  it('local-only store says so and names the bundle as the loss window', () => {
    const v = toStoreView({ ...base, replica: null, replicating: false, litestream: null }, [], now);
    expect(v.mode).toBe('local-only');
    expect(v.lagSeconds).toBeNull();
    expect(v.lossWindow).toContain('last controller backup');
  });
  it('configured but not replicating surfaces why', () => {
    const v = toStoreView({ ...base, replicating: false, litestream: null, replicationBlocked: 'replica unreachable: dns' }, [], now);
    expect(v.problem).toBe('replica unreachable: dns');
  });
});
