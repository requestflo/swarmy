import { describe, expect, test } from 'bun:test';
import { staleControlPlanes } from './mesh-control-fence';

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
