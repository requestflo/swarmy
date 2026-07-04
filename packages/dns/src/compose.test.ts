import { describe, expect, it } from 'bun:test';
import { composeZoneSnapshot, type ZoneComposeInput } from './compose';

function input(overrides: Partial<ZoneComposeInput> = {}): ZoneComposeInput {
  return {
    zone: { name: 'example.com', ttl: 30, serial: 7, apexToEdge: true, autoWww: true },
    advertised: [
      { nodeId: 'node-uk', ip: '203.0.113.10' },
      { nodeId: 'node-za', ip: '198.51.100.20' },
    ],
    autoHosts: [{ host: 'app.example.com', source: 'route' }],
    endpoints: [
      { nodeId: 'node-uk', region: 'uk-scotland', ip: '203.0.113.10', healthy: true },
      { nodeId: 'node-za', region: 'af', ip: '198.51.100.20', healthy: true },
    ],
    manualRecords: [],
    ...overrides,
  };
}

describe('composeZoneSnapshot', () => {
  it('synthesizes ns1..nsN with glue from the pinned set, in order', () => {
    const { snapshot } = composeZoneSnapshot(input());
    expect(snapshot.nameservers).toEqual([
      { label: 'ns1', fqdn: 'ns1.example.com', ip: '203.0.113.10', nodeId: 'node-uk' },
      { label: 'ns2', fqdn: 'ns2.example.com', ip: '198.51.100.20', nodeId: 'node-za' },
    ]);
    expect(snapshot.soa.mname).toBe('ns1.example.com');
    expect(snapshot.soa.rname).toBe('hostmaster.example.com');
    expect(snapshot.serial).toBe(7);
  });

  it('derives geo records for apex, www, and auto hosts', () => {
    const { snapshot } = composeZoneSnapshot(input());
    expect(snapshot.geoRecords.map((g) => g.host)).toEqual([
      'app.example.com',
      'example.com',
      'www.example.com',
    ]);
    expect(snapshot.geoRecords[0]?.endpoints).toHaveLength(2);
    expect(snapshot.geoRecords.find((g) => g.host === 'example.com')?.source).toBe('apex');
  });

  it('respects apexToEdge/autoWww toggles', () => {
    const { snapshot } = composeZoneSnapshot(
      input({ zone: { name: 'example.com', ttl: 30, serial: 1, apexToEdge: false, autoWww: false } }),
    );
    expect(snapshot.geoRecords.map((g) => g.host)).toEqual(['app.example.com']);
  });

  it('manual address record beats the auto geo record, with a conflict', () => {
    const { snapshot, conflicts } = composeZoneSnapshot(
      input({ manualRecords: [{ name: 'app', type: 'A', value: '192.0.2.99' }] }),
    );
    expect(snapshot.geoRecords.map((g) => g.host)).not.toContain('app.example.com');
    expect(snapshot.staticRecords).toEqual([{ name: 'app', type: 'A', value: '192.0.2.99' }]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.name).toBe('app.example.com');
  });

  it('a manual CNAME on www suppresses the auto www record', () => {
    const { snapshot, conflicts } = composeZoneSnapshot(
      input({ manualRecords: [{ name: 'www', type: 'CNAME', value: 'ghs.example.net' }] }),
    );
    expect(snapshot.geoRecords.map((g) => g.host)).not.toContain('www.example.com');
    expect(conflicts.some((c) => c.name === 'www.example.com')).toBe(true);
  });

  it('rejects CNAME and NS at the apex', () => {
    const { snapshot, conflicts } = composeZoneSnapshot(
      input({
        manualRecords: [
          { name: '@', type: 'CNAME', value: 'other.example.net' },
          { name: '@', type: 'NS', value: 'ns.other.net' },
          { name: '@', type: 'TXT', value: 'v=spf1 -all' },
        ],
      }),
    );
    expect(snapshot.staticRecords).toEqual([{ name: '@', type: 'TXT', value: 'v=spf1 -all' }]);
    expect(conflicts.map((c) => c.type).sort()).toEqual(['CNAME', 'NS']);
  });

  it('MX/TXT pass through untouched and apex name normalizes to @', () => {
    const { snapshot } = composeZoneSnapshot(
      input({
        manualRecords: [
          { name: 'example.com.', type: 'MX', value: 'mail.example.com', priority: 10 },
          { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none' },
        ],
      }),
    );
    expect(snapshot.staticRecords).toEqual([
      { name: '@', type: 'MX', value: 'mail.example.com', priority: 10 },
      { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none' },
    ]);
  });

  it('flags empty endpoint sets instead of failing', () => {
    const { snapshot, conflicts } = composeZoneSnapshot(input({ endpoints: [] }));
    expect(snapshot.geoRecords.every((g) => g.endpoints.length === 0)).toBe(true);
    expect(conflicts.some((c) => c.reason.includes('No ingress+outlet endpoints'))).toBe(true);
  });

  it('drops out-of-zone auto hosts silently', () => {
    const { snapshot } = composeZoneSnapshot(
      input({ autoHosts: [{ host: 'app.other-zone.net' }] }),
    );
    expect(snapshot.geoRecords.map((g) => g.host)).toEqual(['example.com', 'www.example.com']);
  });

  it('is deterministic (same input → same snapshot)', () => {
    const a = composeZoneSnapshot(input());
    const b = composeZoneSnapshot(input());
    expect(a.snapshot).toEqual(b.snapshot);
  });
});
