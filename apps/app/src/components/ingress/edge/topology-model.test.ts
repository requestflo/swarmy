import { describe, expect, it } from 'bun:test';
import type { NodeSummary } from '@swarmy/core';
import { controllerPlacement, topologyView } from './topology-model';

const n = (id: string, ingress: boolean, extra: Partial<NodeSummary> = {}): NodeSummary =>
  ({ id, name: id, ingress, status: 'online', region: null, publicIp: null, ...extra }) as unknown as NodeSummary;

const NODES = [
  n('mgr-1', true, { region: 'us-east', publicIp: '203.0.113.10' }),
  n('mgr-2', true, { region: 'eu-west', publicIp: '198.51.100.10', status: 'draining' }),
  n('wkr-1', false),
];

describe('edge topology', () => {
  it('places the one edge the way the controller does: a single pin, then the edge tier, then a manager', () => {
    expect(controllerPlacement(NODES, ['wkr-1'])).toBe('on wkr-1');
    expect(controllerPlacement(NODES, ['mgr-1', 'mgr-2'])).toBe('on one of your edge servers');
    expect(controllerPlacement([n('a', false)], [])).toBe('on a manager');
  });

  it('draws one Caddy per server marked as an edge, with region, IP and health', () => {
    const v = topologyView({ mode: 'edge-per-node', nodes: NODES, targetNodes: [], geo: true, apps: ['storefront'], bucket: 'swarmy-edge-certs' });
    expect(v.edges.map((e) => [e.title, e.sub, e.healthy])).toEqual([
      ['Caddy · mgr-1', 'us-east', true],
      ['Caddy · mgr-2', 'eu-west', false],
    ]);
    expect(v.edges[0]!.tech).toContain('203.0.113.10');
    expect([v.mid.title, v.certs.shared]).toEqual(['swarmy-dns', true]);
  });

  it('without geo-DNS the edges are reached through your own DNS', () => {
    expect(topologyView({ mode: 'edge-per-node', nodes: NODES, targetNodes: [], geo: false, apps: [], bucket: null }).mid.title).toBe('Your DNS');
  });

  it('one replicated edge: a single Caddy, local certificates', () => {
    const v = topologyView({ mode: 'controller', nodes: NODES, targetNodes: ['mgr-1'], geo: true, apps: [], bucket: null });
    expect(v.edges.map((e) => e.sub)).toEqual(['on mgr-1']);
    expect([v.mid.title, v.certs.shared, v.apps.sub]).toEqual(['Your DNS', false, 'No app has an address yet']);
  });
});
