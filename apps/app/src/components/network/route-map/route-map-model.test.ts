import { describe, expect, it } from 'bun:test';
import type { NodeSummary, ServiceSummary, TrafficNowView } from '@swarmy/core';
import type { HubDomain } from '../use-network';
import { buildRouteMap, litPath, litSay, msText, perMinText, shortService } from './route-map-model';

const node = (id: string, status: NodeSummary['status'], publicIp: string | null): NodeSummary =>
  ({ id, name: id, status, publicIp }) as unknown as NodeSummary;

const dom = (host: string, serviceId: string, extra: Partial<HubDomain> = {}): HubDomain => ({
  id: `${serviceId}:${host}`,
  host,
  serviceId,
  stack: 'shop',
  serviceName: `shop_${serviceId}`,
  targetPort: 3000,
  tls: 'auto',
  pathPrefix: null,
  serving: true,
  status: { state: 'active', reason: '', certificate: { expiresAt: null } },
  ...extra,
});

const TRAFFIC: TrafficNowView = {
  sampledAt: 1,
  windowMinutes: 5,
  unit: 'requests/min',
  totals: { requestsPerMin: 612, errors5xxPerMin: 0, errorShare: 0, state: 'reporting' },
  regions: [
    { region: 'eu-west', requestsPerMin: 434, errors5xxPerMin: 0, state: 'reporting', edges: [{ nodeId: 'a', name: 'a', region: 'eu-west', state: 'reporting', requestsPerMin: 434, lastReportAt: 1, p50Ms: 41.6, p95Ms: 230 }] },
    { region: 'us-east', requestsPerMin: 178, errors5xxPerMin: 0, state: 'reporting', edges: [{ nodeId: 'b', name: 'b', region: 'us-east', state: 'reporting', requestsPerMin: 178, lastReportAt: 1 }] },
    { region: 'us-west', requestsPerMin: null, errors5xxPerMin: null, state: 'no-data', edges: [{ nodeId: 'c', name: 'c', region: 'us-west', state: 'no-data', requestsPerMin: null, lastReportAt: null }] },
  ],
  apps: [],
  hosts: [],
};

const NODES = [node('a', 'online', '198.51.100.10'), node('b', 'online', '203.0.113.10'), node('c', 'draining', null)];
const PLACED = new Map<string, ServiceSummary[]>([
  ['a', [{ id: 'web' } as ServiceSummary]],
  ['b', [{ id: 'web' } as ServiceSummary, { id: 'api' } as ServiceSummary]],
]);

describe('route map', () => {
  it('lists every edge traffic.now knows, with its IP and rate, and splits visitors by region', () => {
    const m = buildRouteMap({ domains: [], traffic: TRAFFIC, nodes: NODES, servicesByNode: PLACED });
    expect(m.edges.map((e) => [e.name, e.ip, e.perMin, e.healthy])).toEqual([
      ['a', '198.51.100.10', 434, true],
      ['b', '203.0.113.10', 178, true],
      ['c', null, null, false],
    ]);
    expect(m.visitors).toEqual({ perMin: 612, regions: [{ region: 'eu-west', perMin: 434 }, { region: 'us-east', perMin: 178 }] });
  });

  it('carries each edge`s p50/p95 (board 13); an edge without duration buckets reads null, not 0', () => {
    const m = buildRouteMap({ domains: [], traffic: TRAFFIC, nodes: NODES, servicesByNode: PLACED });
    expect(m.edges.map((e) => [e.name, e.p50Ms, e.p95Ms])).toEqual([['a', 41.6, 230], ['b', null, null], ['c', null, null]]);
    expect([msText(0.4), msText(41.6), msText(1340)]).toEqual(['<1 ms', '42 ms', '1.3 s']);
  });

  it('groups addresses by the service they open, with where it runs and the worst state', () => {
    const waiting = dom('new.example.com', 'web', { status: { state: 'waiting_dns', reason: '', gated: true, certificate: null } });
    const m = buildRouteMap({ domains: [dom('shop.example.com', 'web'), waiting, dom('api.example.com', 'api')], traffic: TRAFFIC, nodes: NODES, servicesByNode: PLACED });
    expect(m.apps.map((a) => [a.service, a.hosts.length, a.where, a.tone])).toEqual([
      ['web', 2, ['a', 'b'], 'warn'],
      ['api', 1, ['b'], 'ok'],
    ]);
    expect(buildRouteMap({ domains: [dom('x.example.com', 'web')], traffic: TRAFFIC, nodes: NODES, servicesByNode: undefined }).apps[0]!.where).toBeUndefined();
  });

  it('lights only the healthy edges, and none while the address is withheld', () => {
    const m = buildRouteMap({ domains: [], traffic: TRAFFIC, nodes: NODES, servicesByNode: PLACED });
    expect([...litPath(m, dom('shop.example.com', 'web'))!.edges]).toEqual(['a', 'b']);
    const gated = litPath(m, dom('new.example.com', 'web', { status: { state: 'waiting_dns', reason: '', gated: true, certificate: null } }))!;
    expect([gated.edges.size, gated.served, gated.app]).toEqual([0, false, 'web']);
    expect(litPath(m, null)).toBeNull();
  });

  it('a lit address carries its own rate, split by edge, and says it', () => {
    const m = buildRouteMap({ domains: [], traffic: TRAFFIC, nodes: NODES, servicesByNode: PLACED });
    const shop = dom('shop.example.com', 'web');
    const visits = { perMin: 348, errors5xxPerMin: 0, windowMinutes: 5, edges: [{ nodeId: 'a', requestsPerMin: 210 }, { nodeId: 'b', requestsPerMin: 138 }] };
    const lit = litPath(m, shop, visits)!;
    expect([lit.perMin, [...lit.byEdge]]).toEqual([348, [['a', 210], ['b', 138]]]);
    expect(litSay(m, shop, lit)).toBe('shop.example.com opens shop / web: 348 visits a minute, 210 through a and 138 through b.');
    const one = litPath(m, shop, { ...visits, perMin: 12, edges: [{ nodeId: 'a', requestsPerMin: 12 }] })!;
    expect(litSay(m, shop, one)).toBe('shop.example.com opens shop / web: 12 visits a minute, all through a.');
    expect(litSay(m, shop, litPath(m, shop, { ...visits, perMin: 0, edges: [] }))).toBe(
      'shop.example.com opens shop / web. No visits in the last 5 minutes; any of your 2 healthy edges can take one.',
    );
    // No number for it (nothing reported, or a tunnel route): the plain sentence, no rate.
    const none = litPath(m, shop, null)!;
    expect([none.perMin, none.byEdge.size]).toEqual([null, 0]);
    expect(litSay(m, shop, none)).toBe('shop.example.com opens shop / web. Any of your 2 healthy edges can take the visit.');
    // A withheld address never shows a rate.
    const gated = dom('new.example.com', 'web', { status: { state: 'waiting_dns', reason: '', gated: true, certificate: null } });
    expect(litPath(m, gated, visits)!.perMin).toBeNull();
  });

  it('shortens names and rates', () => {
    expect(shortService('shop', 'shop_web')).toBe('web');
    expect(shortService('shop', 'web')).toBe('web');
    expect([perMinText(434.4), perMinText(1240), perMinText(25_000)]).toEqual(['434', '1.2k', '25k']);
  });
});
