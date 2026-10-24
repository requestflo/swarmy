import { describe, expect, it } from 'bun:test';
import { DnsSnapshotBundle, DnsZoneSnapshot } from '@swarmy/core/protocol';
import { dashedIpv4, isPublicIpv4, synthAllowList, synthesizedAddress } from './synth';
import { bundleSignature, zoneSignature } from './signature';

const BASE = {
  zone: 'apps.example.com',
  serial: 1,
  ttl: 30,
  soa: { mname: 'ns1.apps.example.com', rname: 'hostmaster.apps.example.com', refresh: 7200, retry: 3600, expire: 1209600, minimum: 30 },
  nameservers: [],
  geoRecords: [],
  staticRecords: [],
};
const cluster = (ips: string[]): DnsZoneSnapshot => ({ ...BASE, synth: { ips } });

describe('dashedIpv4', () => {
  it('reads canonical dashed IPv4 labels only', () => {
    expect(dashedIpv4('5-9-10-200')).toBe('5.9.10.200');
    expect(dashedIpv4('0-0-0-0')).toBe('0.0.0.0');
    expect(dashedIpv4('5-9-10-256')).toBeNull();
    expect(dashedIpv4('05-9-10-1')).toBeNull(); // one name per IP
    expect(dashedIpv4('5-9-10')).toBeNull();
    expect(dashedIpv4('web-5-9-10-1')).toBeNull();
    expect(dashedIpv4('5.9.10.1')).toBeNull();
  });
});

describe('isPublicIpv4 — private and reserved ranges are refused', () => {
  it('accepts globally routable unicast', () => {
    for (const ip of ['5.9.10.200', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1', '223.255.255.254']) {
      expect(isPublicIpv4(ip)).toBe(true);
    }
  });
  it('refuses RFC 1918, CGNAT, loopback, link-local, TEST-NETs, multicast, reserved', () => {
    for (const ip of [
      '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1', '127.0.0.1', '169.254.1.1',
      '0.1.2.3', '192.0.2.1', '198.51.100.20', '203.0.113.10', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ]) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
  });
  it('refuses malformed input', () => {
    expect(isPublicIpv4('2001:db8::1')).toBe(false);
    expect(isPublicIpv4('1.2.3')).toBe(false);
    expect(isPublicIpv4('1.2.3.999')).toBe(false);
  });
});

describe('synthAllowList', () => {
  it('keeps public IPv4 only, sorted and unique', () => {
    expect(synthAllowList(['8.8.4.4', '10.0.0.1', '5.9.10.200', '8.8.4.4', '2001:db8::1'])).toEqual(['5.9.10.200', '8.8.4.4']);
  });
});

describe('synthesizedAddress', () => {
  const z = cluster(['5.9.10.200', '10.0.0.5']);
  it('answers the IP label right under the apex, and names beneath it', () => {
    expect(synthesizedAddress(z, '5-9-10-200.apps.example.com')).toBe('5.9.10.200');
    expect(synthesizedAddress(z, 'web-shop.5-9-10-200.apps.example.com')).toBe('5.9.10.200');
    expect(synthesizedAddress(z, 'a.b.5-9-10-200.apps.example.com')).toBe('5.9.10.200');
  });
  it('only for allowed, public addresses', () => {
    expect(synthesizedAddress(z, '8-8-8-8.apps.example.com')).toBeNull(); // not a cluster node
    expect(synthesizedAddress(z, '10-0-0-5.apps.example.com')).toBeNull(); // private, even when listed
  });
  it('never elsewhere in the name, at the apex, or without synth', () => {
    expect(synthesizedAddress(z, '5-9-10-200.web.apps.example.com')).toBeNull();
    expect(synthesizedAddress(z, 'apps.example.com')).toBeNull();
    expect(synthesizedAddress({ ...BASE }, '5-9-10-200.apps.example.com')).toBeNull();
  });
});

describe('protocol — DnsZoneSnapshot.synth is additive', () => {
  it('parses with and without synth; old snapshots keep their signature', () => {
    const old = DnsZoneSnapshot.parse(BASE);
    expect(old.synth).toBeUndefined();
    const withSynth = DnsZoneSnapshot.parse({ ...BASE, synth: {} });
    expect(withSynth.synth).toEqual({ ips: [] });
    expect(zoneSignature(old)).not.toBe(zoneSignature(cluster(['5.9.10.200'])));
    expect(zoneSignature(cluster(['5.9.10.200']))).not.toBe(zoneSignature(cluster(['5.9.10.201'])));
  });
  it('rejects a malformed synth block', () => {
    expect(DnsZoneSnapshot.safeParse({ ...BASE, synth: { ips: 'all' } }).success).toBe(false);
    expect(DnsZoneSnapshot.safeParse({ ...BASE, synth: { ips: [1] } }).success).toBe(false);
  });
  it('a bundle carrying it round-trips through JSON (the push wire)', () => {
    const bundle = { version: 2, generatedAt: '2026-10-24T00:00:00.000Z', zones: [cluster(['5.9.10.200'])] };
    const back = DnsSnapshotBundle.parse(JSON.parse(JSON.stringify(bundle)));
    expect(back.zones[0]?.synth).toEqual({ ips: ['5.9.10.200'] });
    expect(bundleSignature(back)).toBe(bundleSignature(bundle));
  });
});
