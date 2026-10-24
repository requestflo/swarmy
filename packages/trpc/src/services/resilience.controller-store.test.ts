import { describe, expect, it } from 'bun:test';
import { controllerStoreProblems, controllerStoreSignal, type ControllerStoreSignal } from './resilience.controller-store';
import { toStoreView, type ControllerStoreRuntimeStatus } from './controllerStore.view';

const local: ControllerStoreSignal = {
  mode: 'local-only',
  replicating: false,
  lagSeconds: null,
  problem: null,
  summary: 'controller store: local only',
  hostname: 'mgr-1',
};

describe('controllerStoreProblems (resilience check controller-store)', () => {
  it('local only: warn when another manager could take over, info on a one-manager swarm', () => {
    expect(controllerStoreProblems(local, 3)[0]).toMatchObject({ id: 'controller-store', check: 'controller-store', severity: 'warn' });
    expect(controllerStoreProblems(local, 3)[0]?.detail).toContain('cannot restart on another manager');
    const one = controllerStoreProblems(local, 1)[0];
    expect(one?.severity).toBe('info');
    expect(one?.detail).toBe('controller store: local only. If mgr-1 is lost, everything since the last controller backup goes with it.');
  });

  it('replicated and healthy raises nothing; replicated with a problem warns with the measured line', () => {
    const ok: ControllerStoreSignal = { ...local, mode: 'replicated', replicating: true, lagSeconds: 1, summary: 'controller store: replicated (lag 1s)' };
    expect(controllerStoreProblems(ok, 3)).toEqual([]);
    const behind = { ...ok, lagSeconds: 42, problem: 'the replica is 42s behind', summary: 'controller store: replicated (lag 42s)' };
    const [p] = controllerStoreProblems(behind, 3);
    expect(p).toMatchObject({ severity: 'warn', fixLabel: 'Check replication' });
    expect(p?.detail).toStartWith('controller store: replicated (lag 42s): the replica is 42s behind.');
  });

  it('no store runtime (null/undefined) raises nothing', () => {
    expect(controllerStoreProblems(null, 3)).toEqual([]);
    expect(controllerStoreProblems(undefined, 3)).toEqual([]);
  });

  it('the signal is picked straight off the store view', () => {
    const s = {
      role: 'leader',
      identity: { taskId: 't', nodeId: 'n', hostname: 'mgr-2', service: 'swarmy_controller' },
      lease: null,
      epoch: 1,
      leaseAgeMs: 0,
      waitingFor: null,
      replica: null,
      replicating: false,
      replicationBlocked: null,
      litestream: null,
      bundleConfigured: false,
      boot: null,
      dbPath: '/x/control.db',
    } satisfies ControllerStoreRuntimeStatus;
    expect(controllerStoreSignal(toStoreView(s, []))).toEqual({ ...local, hostname: 'mgr-2' });
  });
});
