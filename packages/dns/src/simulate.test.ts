import { describe, expect, it } from 'bun:test';
import type { DnsZoneSnapshot } from '@swarmy/core/protocol';
import { markEdgesDown, simulateEdgesDown } from './simulate';

const LON = '198.51.100.1';
const FRA = '198.51.100.2';
const NYC = '203.0.113.3';
const SGP = '192.0.2.4';
const HOST = 'shop.northwind.dev';

function zone(): DnsZoneSnapshot {
  return {
    zone: 'northwind.dev',
    serial: 7,
    ttl: 30,
    soa: { mname: 'ns1.northwind.dev', rname: 'hostmaster.northwind.dev', refresh: 7200, retry: 3600, expire: 1209600, minimum: 30 },
    nameservers: [],
    staticRecords: [],
    geoRecords: [
      {
        host: HOST,
        maxAnswers: 2,
        endpoints: [
          { nodeId: 'lon', region: 'eu-west', ip: LON, healthy: true },
          { nodeId: 'fra', region: 'eu-central', ip: FRA, healthy: true },
          { nodeId: 'nyc', region: 'us-east', ip: NYC, healthy: true },
          { nodeId: 'sgp', region: 'ap-southeast', ip: SGP, healthy: true },
        ],
      },
    ],
  };
}

describe('simulateEdgesDown — what if this front door went down?', () => {
  it('drops the edge from every answer and moves visitors to the next nearest healthy one', () => {
    const out = simulateEdgesDown([zone()], HOST, [LON], ['eu', 'us', 'ap']);
    expect(out).toEqual([
      { from: 'eu', before: [FRA, LON], after: [FRA, NYC], degraded: false, steered: true },
      { from: 'us', before: [NYC, LON], after: [NYC, FRA], degraded: false, steered: true },
      { from: 'ap', before: [SGP, FRA], after: [SGP, FRA], degraded: false, steered: true },
    ]);
  });

  it('spills a region whose only nearby edge is down to the next region', () => {
    const [ap] = simulateEdgesDown([zone()], HOST, [SGP], ['ap']);
    expect(ap).toEqual({ from: 'ap', before: [SGP, FRA], after: [FRA, LON], degraded: false, steered: true });
  });

  it('never answers empty: with every edge down it answers with everyone', () => {
    const [eu] = simulateEdgesDown([zone()], HOST, [LON, FRA, NYC, SGP], ['eu']);
    expect(eu!.degraded).toBe(true);
    expect(eu!.after).toEqual([FRA, LON]);
  });

  it('answers in a fixed order for a region the engine cannot place', () => {
    const [x] = simulateEdgesDown([zone()], HOST, [LON], ['zz']);
    expect(x!.steered).toBe(false);
    expect(x!.after).not.toContain(LON);
  });

  it('changes nothing: the zones passed in keep their health', () => {
    const zones = [zone()];
    markEdgesDown(zones, [LON]);
    simulateEdgesDown(zones, HOST, [LON], ['eu']);
    expect(zones[0]!.geoRecords[0]!.endpoints.every((e) => e.healthy)).toBe(true);
  });
});
