import { describe, expect, test } from 'bun:test';
import { nearestLink } from '@/components/networking/mesh-link-words';
import { demoMeshLinks } from './mesh-links';

const seeded = [
  { nodeId: 'n-mgr-1', status: 'CONNECTED' },
  { nodeId: 'n-mgr-2', status: 'CONNECTED' },
  { nodeId: 'n-wkr-1', status: 'CONNECTED' },
  { nodeId: 'n-wkr-2', status: 'ENROLLED' },
];

describe('demo mesh.links', () => {
  test('the seeded world: managers side by side, wkr-1 through the relay, one end not reported', () => {
    const links = demoMeshLinks(seeded, new Date(0));
    expect(links.map((l) => [l.a, l.b, l.ab?.latencyMs ?? null, l.ba?.latencyMs ?? null, l.ab?.relayed ?? l.ba?.relayed])).toEqual([
      ['n-mgr-1', 'n-mgr-2', 0.6, 0.7, false],
      ['n-mgr-1', 'n-wkr-1', 19.4, 18.9, true],
      ['n-mgr-2', 'n-wkr-1', null, 21.2, true],
    ]);
  });

  test('a server that joins (Add a server) is direct to wkr-1 in the same house at 0.4 ms', () => {
    const links = demoMeshLinks([...seeded, { nodeId: 'n-pi-garage', status: 'CONNECTED' }]);
    expect(nearestLink(links, 'n-pi-garage')).toEqual({ other: 'n-wkr-1', path: 'direct', latency: '0.4 ms' });
    const toMgr = links.find((l) => l.a === 'n-mgr-1' && l.b === 'n-pi-garage')!;
    // a → b is the manager's own view of the newcomer.
    expect([toMgr.ab?.latencyMs, toMgr.ba?.latencyMs]).toEqual([11.7, 11]);
  });
});
