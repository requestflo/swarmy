import { describe, expect, it } from 'bun:test';
import { LAG_WARN_SECONDS, STALE_READ_MS, storeSummary, toStoreView, type ControllerStoreRuntimeStatus } from './controllerStore.view';

const ls: NonNullable<ControllerStoreRuntimeStatus['litestream']> = {
  running: true,
  lastSyncAt: '2026-09-24T10:00:00.000Z',
  txid: '00000000000000aa',
  replicaTxid: '00000000000000aa',
  behindTxns: 0,
  lagMs: 0,
  replicaCheckedAgoMs: 3_000,
  error: null,
  restarts: 0,
};
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
  litestream: ls,
  bundleConfigured: true,
  boot: { at: '2026-09-24T09:59:00.000Z', decision: { kind: 'restore-replica', reason: 'no local file' }, outcome: 'restored', durationMs: 900 },
  dbPath: '/var/lib/swarmy/data/control.db',
};
const view = (over: Partial<ControllerStoreRuntimeStatus> = {}, lit: Partial<typeof ls> = {}) =>
  toStoreView({ ...base, litestream: { ...ls, ...lit }, ...over }, []);

describe('toStoreView', () => {
  it('caught up → lag 0, replicated mode, ~1 s loss window, one-line summary', () => {
    const v = view();
    expect(v).toMatchObject({ mode: 'replicated', lagSeconds: 0, behindTxns: 0, epoch: 3, leaseRenewedAgoSec: 4, problem: null });
    expect(v.summary).toBe('controller store: replicated (lag 0s)');
    expect(v.lossWindow).toContain('1 second');
    expect(v.boot?.kind).toBe('restore-replica');
  });

  it('shows the measured lag, and calls it a problem from LAG_WARN_SECONDS', () => {
    const v = view({}, { lagMs: 4_400, behindTxns: 12 });
    expect(v).toMatchObject({ lagSeconds: 4, behindTxns: 12, problem: null, summary: 'controller store: replicated (lag 4s)' });
    expect(v.lossWindow).toContain('about 4 seconds');
    expect(view({}, { lagMs: LAG_WARN_SECONDS * 1000 }).problem).toBe(`the replica is ${LAG_WARN_SECONDS}s behind`);
  });

  it('an unreadable replica keeps the growing lag and says why', () => {
    const v = view({}, { lagMs: 95_000, replicaCheckedAgoMs: 120_000, error: "can't read the replica: timeout" });
    expect(v).toMatchObject({ lagSeconds: 95, problem: "can't read the replica: timeout", summary: 'controller store: replicated (lag 95s)' });
  });

  it('a replica read that stopped without an error is not a lag claim', () => {
    const v = view({}, { replicaCheckedAgoMs: STALE_READ_MS + 1_000 });
    expect(v.lagSeconds).toBeNull();
    expect(v.summary).toBe('controller store: replicated (lag unknown)');
    expect(v.problem).toContain("hasn't been read for 61s");
  });

  it('local-only store says so and names the bundle as the loss window', () => {
    const v = toStoreView({ ...base, replica: null, replicating: false, litestream: null }, []);
    expect(v).toMatchObject({ mode: 'local-only', lagSeconds: null, behindTxns: null, summary: 'controller store: local only' });
    expect(v.lossWindow).toContain('last controller backup');
  });

  it('configured but not replicating surfaces why', () => {
    const v = toStoreView({ ...base, replicating: false, litestream: null, replicationBlocked: 'replica unreachable: dns' }, []);
    expect(v.problem).toBe('replica unreachable: dns');
    expect(v.summary).toBe('controller store: replicated (not shipping yet)');
  });
});

describe('storeSummary', () => {
  it('a fenced controller says so before anything else', () => {
    expect(storeSummary({ role: 'fenced', mode: 'replicated', replicating: true, lagSeconds: 0 })).toContain('fenced');
  });
});
