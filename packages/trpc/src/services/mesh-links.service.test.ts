import { afterEach, describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { getMeshLinks, MeshLinkLiveStore, meshLinksLive, pairMeshLinks, type MeshLinkReport } from './mesh-links.service';
import { meshPeers } from './mesh-peers';

const T = Date.UTC(2026, 9, 26, 10, 42);
const report = (at: number, links: Record<string, object>): MeshLinkReport => ({ at, links: new Map(Object.entries(links)) });
const ips = new Map([
  ['100.92.4.1', 'n-lon-1'],
  ['100.92.4.2', 'n-lon-2'],
  ['100.92.4.20', 'n-home'],
]);

afterEach(() => {
  meshLinksLive.clear();
  meshPeers.clear();
});

describe('pairMeshLinks', () => {
  it('pairs both ends of a link by server, keeping each direction (they can differ)', () => {
    const links = pairMeshLinks(
      new Map([
        ['n-lon-1', report(T, { '100.92.4.20': { latencyMs: 11, relayed: false, rxBytes: 10, txBytes: 20 } })],
        ['n-home', report(T + 1000, { '100.92.4.1': { latencyMs: 12.5, relayed: false }, '100.92.4.2': { latencyMs: 19, relayed: true } })],
      ]),
      ips,
    );
    expect(links).toEqual([
      {
        a: 'n-home',
        b: 'n-lon-1',
        ab: { latencyMs: 12.5, relayed: false, rxBytes: null, txBytes: null, at: '2026-10-26T10:42:01.000Z' },
        ba: { latencyMs: 11, relayed: false, rxBytes: 10, txBytes: 20, at: '2026-10-26T10:42:00.000Z' },
      },
      // Only home-lab's agent reported this one (london-2's is older): the other end is null.
      { a: 'n-home', b: 'n-lon-2', ab: { latencyMs: 19, relayed: true, rxBytes: null, txBytes: null, at: '2026-10-26T10:42:01.000Z' }, ba: null },
    ]);
  });

  it('skips peers that are not the org\'s servers (laptops, routers) and a node\'s own address', () => {
    const links = pairMeshLinks(new Map([['n-lon-1', report(T, { '100.92.4.31': { latencyMs: 30 }, '100.92.4.1': { latencyMs: 0.01 } })]]), ips);
    expect(links).toEqual([]);
  });
});

describe('MeshLinkLiveStore', () => {
  it('keeps only peers with link facts, replaces a node\'s last report, and forgets stale ones', () => {
    const s = new MeshLinkLiveStore();
    s.report('org-a', 'n-lon-1', [{ meshIp: '100.92.4.20', link: { latencyMs: 11 } }, { meshIp: '100.92.4.2' }, { link: { latencyMs: 3 } }], T);
    expect([...s.fresh('org-a', T).get('n-lon-1')!.links.keys()]).toEqual(['100.92.4.20']);
    // An older agent: peers without link facts → nothing to show for it.
    s.report('org-a', 'n-lon-1', [{ meshIp: '100.92.4.20' }], T + 5);
    expect(s.fresh('org-a', T + 5).get('n-lon-1')!.links.size).toBe(0);
    expect(s.fresh('org-a', T + 5 + 120_001).size).toBe(0);
  });

  it('is org-scoped: one org never sees another\'s reports', () => {
    const s = new MeshLinkLiveStore();
    s.report('org-a', 'n-1', [{ meshIp: '100.92.4.2', link: { latencyMs: 1 } }], T);
    expect(s.fresh('org-b', T).size).toBe(0);
  });
});

describe('getMeshLinks', () => {
  it('resolves peer addresses through the org\'s own live peers only', () => {
    meshPeers.upsert('org-a', 'n-lon-1', { meshIp: '100.92.4.1', status: 'CONNECTED' });
    meshPeers.upsert('org-a', 'n-home', { meshIp: '100.92.4.20', status: 'CONNECTED' });
    // Another org's server on the same address range must not match.
    meshPeers.upsert('org-b', 'n-other', { meshIp: '100.92.4.2', status: 'CONNECTED' });
    meshLinksLive.report('org-a', 'n-lon-1', [{ meshIp: '100.92.4.20', link: { latencyMs: 0.4, relayed: false } }, { meshIp: '100.92.4.2', link: { latencyMs: 9 } }], T);
    meshLinksLive.report('org-b', 'n-other', [{ meshIp: '100.92.4.1', link: { latencyMs: 5 } }], T);
    const a = getMeshLinks({ activeOrgId: 'org-a' } as unknown as OrgContext, T);
    expect(a.map((l) => [l.a, l.b, l.ab?.latencyMs ?? null, l.ba?.latencyMs ?? null])).toEqual([['n-home', 'n-lon-1', null, 0.4]]);
    expect(getMeshLinks({ activeOrgId: 'org-b' } as unknown as OrgContext, T)).toEqual([]);
  });
});
