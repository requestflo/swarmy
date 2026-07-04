import { describe, expect, it } from 'bun:test';
import type { DnsSnapshotBundle, DnsZoneSnapshot } from '@swarmy/core/protocol';
import { bundleSignature, zoneSignature } from './signature';

function zone(overrides: Partial<DnsZoneSnapshot> = {}): DnsZoneSnapshot {
  return {
    zone: 'example.com',
    serial: 1,
    ttl: 30,
    soa: {
      mname: 'ns1.example.com',
      rname: 'hostmaster.example.com',
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minimum: 30,
    },
    nameservers: [],
    geoRecords: [
      {
        host: 'app.example.com',
        maxAnswers: 2,
        endpoints: [{ nodeId: 'n1', region: 'eu-west', ip: '203.0.113.10', healthy: true }],
      },
    ],
    staticRecords: [],
    ...overrides,
  };
}

const bundle = (...zones: DnsZoneSnapshot[]): DnsSnapshotBundle => ({
  version: 1,
  generatedAt: '2026-07-04T00:00:00Z',
  zones,
});

describe('zoneSignature', () => {
  it('is stable for identical content', () => {
    expect(zoneSignature(zone())).toBe(zoneSignature(zone()));
  });

  it('ignores serial (serial derives FROM content changes)', () => {
    expect(zoneSignature(zone({ serial: 1 }))).toBe(zoneSignature(zone({ serial: 99 })));
  });

  it('changes when a health bit flips', () => {
    const flipped = zone();
    flipped.geoRecords[0]!.endpoints[0]!.healthy = false;
    expect(zoneSignature(zone())).not.toBe(zoneSignature(flipped));
  });

  it('changes when an endpoint IP changes', () => {
    const moved = zone();
    moved.geoRecords[0]!.endpoints[0]!.ip = '198.51.100.99';
    expect(zoneSignature(zone())).not.toBe(zoneSignature(moved));
  });
});

describe('bundleSignature', () => {
  it('is zone-order-insensitive', () => {
    const a = zone();
    const b = zone({ zone: 'other.net' });
    expect(bundleSignature(bundle(a, b))).toBe(bundleSignature(bundle(b, a)));
  });

  it('ignores version/generatedAt', () => {
    const s1 = bundleSignature({ ...bundle(zone()), version: 1, generatedAt: 'x' });
    const s2 = bundleSignature({ ...bundle(zone()), version: 2, generatedAt: 'y' });
    expect(s1).toBe(s2);
  });

  it('changes when a zone is added', () => {
    expect(bundleSignature(bundle(zone()))).not.toBe(
      bundleSignature(bundle(zone(), zone({ zone: 'other.net' }))),
    );
  });
});
