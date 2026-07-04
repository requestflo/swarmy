import { describe, expect, it } from 'bun:test';
import type { Question } from 'dns-packet';
import type { DnsZoneSnapshot } from '@swarmy/core/protocol';
import { answerQuery, findZone } from './answer';

/** dns-packet's Answer union blocks .data on OPT — tests read via this view. */
const data = (a: unknown): unknown => (a as { data?: unknown }).data;
import type { ClientLocation } from './steer';

const UK_IP = '203.0.113.10';
const ZA_IP = '198.51.100.20';

function zone(overrides: Partial<DnsZoneSnapshot> = {}): DnsZoneSnapshot {
  return {
    zone: 'example.com',
    serial: 42,
    ttl: 30,
    soa: {
      mname: 'ns1.example.com',
      rname: 'hostmaster.example.com',
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minimum: 30,
    },
    nameservers: [
      { label: 'ns1', fqdn: 'ns1.example.com', ip: UK_IP, nodeId: 'node-uk' },
      { label: 'ns2', fqdn: 'ns2.example.com', ip: ZA_IP, nodeId: 'node-za' },
    ],
    geoRecords: [
      {
        host: 'app.example.com',
        maxAnswers: 1,
        endpoints: [
          { nodeId: 'node-uk', region: 'eu-west', ip: UK_IP, healthy: true },
          { nodeId: 'node-za', region: 'af', ip: ZA_IP, healthy: true },
        ],
      },
    ],
    staticRecords: [
      { name: '@', type: 'MX', value: 'mail.example.com', priority: 10 },
      { name: '@', type: 'TXT', value: 'v=spf1 -all' },
      { name: 'docs', type: 'CNAME', value: 'app.example.com' },
      { name: 'ext', type: 'CNAME', value: 'other.example.net' },
      { name: 'v6', type: 'AAAA', value: '2001:db8::1' },
    ],
    ...overrides,
  };
}

const q = (name: string, type: string): Question => ({ name, type }) as Question;
// Roughly Johannesburg / Edinburgh.
const zaClient: ClientLocation = { coord: { lat: -26.2, lon: 28.0 } };
const ukClient: ClientLocation = { coord: { lat: 55.9, lon: -3.2 } };
const nowhere: ClientLocation = {};

describe('findZone', () => {
  it('prefers the longest matching suffix', () => {
    const zones = [zone(), zone({ zone: 'eu.example.com' })];
    expect(findZone(zones, 'app.eu.example.com')?.zone).toBe('eu.example.com');
    expect(findZone(zones, 'app.example.com')?.zone).toBe('example.com');
    expect(findZone(zones, 'example.org')).toBeUndefined();
  });
});

describe('answerQuery — geo steering', () => {
  it('answers A with the nearest healthy node for the client', () => {
    const za = answerQuery([zone()], q('app.example.com', 'A'), zaClient);
    expect(za.rcode).toBe('NOERROR');
    expect(za.aa).toBe(true);
    expect(za.steered).toBe(true);
    expect(za.answers).toEqual([
      { name: 'app.example.com', type: 'A', ttl: 30, data: ZA_IP },
    ]);

    const uk = answerQuery([zone()], q('app.example.com', 'A'), ukClient);
    expect(data(uk.answers[0])).toBe(UK_IP);
  });

  it('omits unhealthy regions and spills when everything is down', () => {
    const oneDown = zone();
    oneDown.geoRecords[0]!.endpoints[1]!.healthy = false; // ZA down
    const za = answerQuery([oneDown], q('app.example.com', 'A'), zaClient);
    expect(data(za.answers[0])).toBe(UK_IP);
    expect(za.degraded).toBe(false);

    const allDown = zone();
    for (const e of allDown.geoRecords[0]!.endpoints) e.healthy = false;
    const spilled = answerQuery([allDown], q('app.example.com', 'A'), zaClient);
    expect(spilled.answers.length).toBeGreaterThan(0); // never empty on health
    expect(spilled.degraded).toBe(true);
  });

  it('answers deterministically when the client cannot be located', () => {
    const a = answerQuery([zone()], q('app.example.com', 'A'), nowhere);
    const b = answerQuery([zone()], q('app.example.com', 'A'), nowhere);
    expect(a.steered).toBe(false);
    expect(a.answers).toEqual(b.answers);
  });

  it('matches names case-insensitively (0x20 tolerance)', () => {
    const res = answerQuery([zone()], q('APP.ExAmPlE.CoM', 'A'), ukClient);
    expect(res.rcode).toBe('NOERROR');
    expect(data(res.answers[0])).toBe(UK_IP);
  });
});

describe('answerQuery — zone plumbing', () => {
  it('REFUSED for zones we do not host', () => {
    const res = answerQuery([zone()], q('other.net', 'A'), ukClient);
    expect(res.rcode).toBe('REFUSED');
    expect(res.aa).toBe(false);
  });

  it('NXDOMAIN with SOA authority for unknown names', () => {
    const res = answerQuery([zone()], q('missing.example.com', 'A'), ukClient);
    expect(res.rcode).toBe('NXDOMAIN');
    expect(res.authorities[0]?.type).toBe('SOA');
  });

  it('NODATA (NOERROR + SOA) for existing names lacking the type', () => {
    const res = answerQuery([zone()], q('app.example.com', 'MX'), ukClient);
    expect(res.rcode).toBe('NOERROR');
    expect(res.answers).toEqual([]);
    expect(res.authorities[0]?.type).toBe('SOA');
  });

  it('empty non-terminals are NODATA, not NXDOMAIN', () => {
    const withDeep = zone({
      staticRecords: [{ name: 'a.b', type: 'TXT', value: 'deep' }],
    });
    const res = answerQuery([withDeep], q('b.example.com', 'A'), ukClient);
    expect(res.rcode).toBe('NOERROR');
    expect(res.answers).toEqual([]);
  });

  it('apex NS with glue additionals; apex SOA; unknown qtype → NODATA', () => {
    const ns = answerQuery([zone()], q('example.com', 'NS'), ukClient);
    expect(ns.answers.map((a) => data(a)).sort()).toEqual([
      'ns1.example.com',
      'ns2.example.com',
    ]);
    expect(ns.additionals).toHaveLength(2);

    const soa = answerQuery([zone()], q('example.com', 'SOA'), ukClient);
    expect(soa.answers[0]?.type).toBe('SOA');
    expect((soa.answers[0] as { data: { serial: number } }).data.serial).toBe(42);

    const https = answerQuery([zone()], q('app.example.com', 'HTTPS'), ukClient);
    expect(https.rcode).toBe('NOERROR');
    expect(https.answers).toEqual([]);
  });

  it('glue hosts answer A directly', () => {
    const res = answerQuery([zone()], q('ns2.example.com', 'A'), ukClient);
    expect(res.answers).toEqual([
      { name: 'ns2.example.com', type: 'A', ttl: 30, data: ZA_IP },
    ]);
  });
});

describe('answerQuery — static records', () => {
  it('serves MX and TXT at the apex', () => {
    const mx = answerQuery([zone()], q('example.com', 'MX'), ukClient);
    expect(mx.answers[0]).toMatchObject({
      type: 'MX',
      data: { preference: 10, exchange: 'mail.example.com' },
    });
    const txt = answerQuery([zone()], q('example.com', 'TXT'), ukClient);
    expect(data(txt.answers[0])).toBe('v=spf1 -all');
  });

  it('serves AAAA statics while geo stays v4-only', () => {
    const res = answerQuery([zone()], q('v6.example.com', 'AAAA'), ukClient);
    expect(data(res.answers[0])).toBe('2001:db8::1');
    const geo6 = answerQuery([zone()], q('app.example.com', 'AAAA'), ukClient);
    expect(geo6.answers).toEqual([]); // NODATA — name exists
    expect(geo6.rcode).toBe('NOERROR');
  });

  it('chases in-zone CNAMEs for the queried type', () => {
    const res = answerQuery([zone()], q('docs.example.com', 'A'), zaClient);
    expect(res.answers[0]).toMatchObject({ type: 'CNAME', data: 'app.example.com' });
    expect(res.answers[1]).toMatchObject({ type: 'A', data: ZA_IP }); // steered chase
    expect(res.steered).toBe(true);
  });

  it('returns bare CNAME for out-of-zone targets', () => {
    const res = answerQuery([zone()], q('ext.example.com', 'A'), ukClient);
    expect(res.answers).toEqual([
      { name: 'ext.example.com', type: 'CNAME', ttl: 30, data: 'other.example.net' },
    ]);
  });
});

describe('answerQuery — ANY (RFC 8482)', () => {
  it('answers ANY with minimal HINFO', () => {
    const res = answerQuery([zone()], q('app.example.com', 'ANY'), ukClient);
    expect(res.answers[0]).toMatchObject({ type: 'HINFO', data: { cpu: 'RFC8482' } });
  });
});
