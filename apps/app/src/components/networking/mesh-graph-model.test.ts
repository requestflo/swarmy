import { describe, expect, test } from 'bun:test';
import { layoutMeshGraph, stateOf, type MeshPeerLike } from './mesh-graph-model';

const peer = (nodeId: string, status: string, relayed: boolean | null = false): MeshPeerLike => ({
  nodeId,
  meshIp: `100.92.0.${nodeId.length}`,
  status,
  lastSeen: null,
  relayed,
});
const names = new Map([['a', 'mgr-1'], ['b', 'mgr-2'], ['c', 'wkr-1'], ['d', 'wkr-2']]);

describe('stateOf', () => {
  test('maps the peer status ladder and the relayed flag', () => {
    expect(stateOf({ status: 'ENROLLING', relayed: null })).toBe('joining');
    expect(stateOf({ status: 'ENROLLED', relayed: null })).toBe('joining');
    expect(stateOf({ status: 'CONNECTED', relayed: false })).toBe('direct');
    expect(stateOf({ status: 'CONNECTED', relayed: true })).toBe('relayed');
    expect(stateOf({ status: 'CONNECTED', relayed: null })).toBe('unknown');
    expect(stateOf({ status: 'DEGRADED', relayed: false })).toBe('trouble');
    expect(stateOf({ status: 'FAILED', relayed: null })).toBe('trouble');
  });
});

describe('layoutMeshGraph', () => {
  test('the demo world: two direct managers, a relayed NAT worker, one joining', () => {
    const g = layoutMeshGraph({
      peers: [peer('a', 'CONNECTED'), peer('b', 'CONNECTED'), peer('c', 'CONNECTED', true), peer('d', 'ENROLLED', null)],
      names,
      nat: new Set(['c']),
      width: 700,
    });
    expect(g.nodes.map((n) => [n.name, n.state, n.nat])).toEqual([
      ['mgr-1', 'direct', false],
      ['mgr-2', 'direct', false],
      ['wkr-2', 'joining', false],
      ['wkr-1', 'relayed', true],
    ]);
    expect(g.zone).not.toBeNull();
    // The relay sits left of the zone, level with it.
    expect(g.relay!.x).toBeLessThan(g.zone!.x);
    expect(g.relay!.y).toBeGreaterThan(g.zone!.y);
    // The NAT'd server sits inside its zone, below the public row.
    const c = g.nodes.find((n) => n.id === 'c')!;
    expect(c.x).toBeGreaterThan(g.zone!.x);
    expect(c.y).toBeGreaterThan(g.zone!.y);
    expect(g.links.map((l) => [l.id, l.kind])).toEqual([
      ['a~b', 'direct'],
      ['c~relay', 'relayed'],
      ['relay~a', 'relayed'],
      ['relay~b', 'relayed'],
      ['d~join', 'joining'],
    ]);
    expect(g.height).toBe(g.zone!.y + g.zone!.h + 20);
  });

  test('on a narrow canvas the relay takes the first row\'s last slot instead', () => {
    const g = layoutMeshGraph({ peers: [peer('a', 'CONNECTED'), peer('c', 'CONNECTED', true)], names, nat: new Set(['c']), width: 420 });
    expect(g.relay!.y).toBeLessThan(g.zone!.y);
  });

  test('no relay and no zone when nobody relays and nothing is behind NAT', () => {
    const g = layoutMeshGraph({ peers: [peer('a', 'CONNECTED'), peer('b', 'CONNECTED', null)], names, nat: new Set(), width: 700 });
    expect(g.relay).toBeNull();
    expect(g.zone).toBeNull();
    expect(g.links).toEqual([expect.objectContaining({ id: 'a~b', kind: 'unknown' })]);
  });

  test('a server in trouble gets no links; a joining one with nobody connected reaches for nobody', () => {
    const g = layoutMeshGraph({ peers: [peer('a', 'FAILED'), peer('b', 'ENROLLING', null)], names, nat: new Set(), width: 700 });
    expect(g.links).toEqual([]);
  });

  test('a narrow canvas wraps the public servers into more rows', () => {
    const peers = ['a', 'b', 'c', 'd'].map((id) => peer(id, 'CONNECTED'));
    const wide = layoutMeshGraph({ peers, names, nat: new Set(), width: 800 });
    const narrow = layoutMeshGraph({ peers, names, nat: new Set(), width: 360 });
    expect(new Set(wide.nodes.map((n) => Math.round(n.y / 100))).size).toBe(1);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });
});
