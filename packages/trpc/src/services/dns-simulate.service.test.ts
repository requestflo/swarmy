import { describe, expect, it } from 'bun:test';
import type { DnsZoneSnapshot } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { simulateEdgeDown, type DownSimulationDeps } from './dns-simulate.service';

const LON = '198.51.100.1';
const NYC = '203.0.113.3';

const snapshot: DnsZoneSnapshot = {
  zone: 'northwind.dev',
  serial: 3,
  ttl: 30,
  soa: { mname: 'ns1.northwind.dev', rname: 'hostmaster.northwind.dev', refresh: 7200, retry: 3600, expire: 1209600, minimum: 30 },
  nameservers: [],
  staticRecords: [],
  geoRecords: [
    {
      host: 'northwind.dev',
      maxAnswers: 2,
      endpoints: [
        { nodeId: 'lon', region: 'eu-west', ip: LON, healthy: true },
        { nodeId: 'nyc', region: 'us-east', ip: NYC, healthy: true },
      ],
    },
  ],
};

const ctx = { activeOrgId: 'org_1' } as unknown as OrgContext;
const deps: DownSimulationDeps = { snapshot: async () => structuredClone(snapshot) };

describe('simulateEdgeDown — read-only "what if this front door went down?"', () => {
  it('answers each region with the edge marked down, and says how long answers last', async () => {
    const view = await simulateEdgeDown(ctx, 'z1', { host: 'northwind.dev', ip: LON, regions: ['eu', 'us'] }, deps);
    expect(view.ttl).toBe(30);
    expect(view.down).toEqual({ ip: LON, region: 'eu-west', healthy: true });
    expect(view.regions.map((r) => [r.from, r.before, r.after])).toEqual([
      ['eu', [LON, NYC], [NYC]],
      ['us', [NYC, LON], [NYC]],
    ]);
  });

  it('refuses an address that is not a front door for the zone', async () => {
    await expect(simulateEdgeDown(ctx, 'z1', { host: 'northwind.dev', ip: '192.0.2.99', regions: ['eu'] }, deps)).rejects.toThrow(
      'is not a front door that answers for northwind.dev',
    );
  });
});
