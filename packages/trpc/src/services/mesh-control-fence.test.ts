import { describe, expect, test } from 'bun:test';
import { leaseWarning, movingAwayFrom, staleControlPlanes } from './mesh-control-fence';

const at = new Date(0);
const report = (nodeId: string, running: boolean, healthy = running) => ({
  nodeId,
  at,
  status: { running, healthy, waitingForConfig: false },
});

describe('fencing a control plane that came back after a move', () => {
  test('a running control plane on any node but the current one is fenced', () => {
    expect(staleControlPlanes([report('new', true), report('old', true), report('other', false)], 'new')).toEqual(['old']);
  });

  test('never while the current one is down, unhealthy or unknown (the only one may be the "stale" one)', () => {
    expect(staleControlPlanes([report('new', false), report('old', true)], 'new')).toEqual([]);
    expect(staleControlPlanes([report('new', true, false), report('old', true)], 'new')).toEqual([]);
    expect(staleControlPlanes([report('old', true)], 'new')).toEqual([]);
    expect(staleControlPlanes([report('old', true)], undefined)).toEqual([]);
  });

  test('steady state fences nothing', () => {
    expect(staleControlPlanes([report('new', true)], 'new')).toEqual([]);
  });
});

describe('a move stops every control plane but the target', () => {
  test('the recorded host and any other that reports one running', () => {
    expect(movingAwayFrom('a', [report('b', true), report('c', false), report('t', true)], 't')).toEqual(['a', 'b']);
    expect(movingAwayFrom(null, [], 't')).toEqual([]);
    expect(movingAwayFrom('t', [report('t', true)], 't')).toEqual([]);
  });
});

describe('the card says what the lease is doing', () => {
  const st = (lease: object) => ({ running: true, healthy: true, waitingForConfig: false, lease: { replicate: false, ...lease } as never });
  test('paused backups, a takeover in progress, a lost lease; nothing when held or unknown', () => {
    expect(leaseWarning(st({ state: 'silent' }))).toContain('backups to the replica are paused');
    expect(leaseWarning(st({ state: 'silent', replicate: true }))).toBeNull();
    expect(leaseWarning(st({ state: 'waiting', holderHostname: 'node-1' }))).toContain('Waiting for node-1');
    expect(leaseWarning(st({ state: 'lost', holderNode: 'n2' }))).toContain('lost the control-plane lease to n2');
    expect(leaseWarning(st({ state: 'held', replicate: true }))).toBeNull();
    expect(leaseWarning({ running: true, healthy: true, waitingForConfig: false })).toBeNull();
  });
});
