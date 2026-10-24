import { describe, expect, it } from 'bun:test';
import { latencyView, type TrafficNowView } from '@swarmy/core';
import { demoHistogram, withDemoExtras } from './traffic-latency';

const edge = (nodeId: string, region: string, requestsPerMin: number | null) => ({
  nodeId,
  name: nodeId,
  region,
  state: requestsPerMin === null ? ('no-data' as const) : ('reporting' as const),
  requestsPerMin,
  lastReportAt: requestsPerMin === null ? null : 1,
});
const host = (h: string, perMin: number, edges: Array<[string, number]>) => ({
  host: h,
  app: 'storefront',
  requestsPerMin: perMin,
  errors5xxPerMin: 0,
  errorShare: 0,
  edges: edges.map(([nodeId, requestsPerMin]) => ({ nodeId, requestsPerMin })),
});
const VIEW = {
  sampledAt: 1,
  windowMinutes: 5,
  unit: 'requests/min',
  totals: { requestsPerMin: 612, errors5xxPerMin: 0, errorShare: 0, state: 'reporting' },
  regions: [
    { region: 'eu-west', requestsPerMin: 434, errors5xxPerMin: 0, state: 'reporting', edges: [edge('eu', 'eu-west', 434)] },
    { region: 'us-east', requestsPerMin: 178, errors5xxPerMin: 0, state: 'reporting', edges: [edge('us', 'us-east', 178)] },
    { region: 'us-west', requestsPerMin: null, errors5xxPerMin: null, state: 'no-data', edges: [edge('usw', 'us-west', null)] },
  ],
  apps: [],
  hosts: [host('shop.northwind.dev', 400, [['eu', 300], ['us', 100]]), host('api.northwind.dev', 212, [['eu', 134], ['us', 78]])],
} as TrafficNowView;

describe('demo traffic — answer times and blocked, merged like the controller', () => {
  it('a demo histogram centres on its median', () => {
    expect(latencyView(demoHistogram(34, 2000)).p50Ms).toBeGreaterThan(25);
    expect(latencyView(demoHistogram(34, 2000)).p50Ms).toBeLessThan(45);
  });

  it('p50 per edge sits between its addresses; the estate merges every edge; a silent edge stays null', () => {
    const v = withDemoExtras(VIEW);
    const eu = v.regions[0]!.edges[0]!;
    const us = v.regions[1]!.edges[0]!;
    expect(eu.p50Ms!).toBeLessThan(us.p50Ms!);
    expect(v.totals.p50Ms!).toBeGreaterThan(eu.p50Ms!);
    expect(v.totals.p50Ms!).toBeLessThan(us.p50Ms!);
    expect(v.regions[2]!.edges[0]).toMatchObject({ p50Ms: null, p95Ms: null });
  });

  it('blocked is each address`s 403 + 429 share; shop`s rate limit shows as 429s', () => {
    const v = withDemoExtras(VIEW);
    const shop = v.hosts.find((h) => h.host === 'shop.northwind.dev')!;
    expect(shop).toMatchObject({ forbiddenPerMin: 2.4, tooManyPerMin: 8.4, blockedPerMin: 10.8 });
    expect(v.totals.blockedPerMin).toBe(11.4);
  });
});
