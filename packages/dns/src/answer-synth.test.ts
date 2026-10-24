import { describe, expect, it } from 'bun:test';
import type { Question } from 'dns-packet';
import type { DnsZoneSnapshot } from '@swarmy/core/protocol';
import { answerQuery } from './answer';
import type { ClientLocation } from './steer';

/**
 * The cluster zone (plans/self-reliance.md B2b): route names answer with the
 * steered edges like any other host, `<a-b-c-d>.<zone>` names synthesise —
 * and the never-empty rule still holds.
 */

const data = (a: unknown): unknown => (a as { data?: unknown }).data;
const q = (name: string, type: string): Question => ({ name, type }) as Question;
const UK = '5.9.10.200';
const ZA = '41.76.108.20';
const za: ClientLocation = { coord: { lat: -26.2, lon: 28.0 } };
const uk: ClientLocation = { coord: { lat: 55.9, lon: -3.2 } };
const endpoints = [
  { nodeId: 'node-uk', region: 'eu-west', ip: UK, healthy: true },
  { nodeId: 'node-za', region: 'af-south', ip: ZA, healthy: true },
];

function zone(overrides: Partial<DnsZoneSnapshot> = {}): DnsZoneSnapshot {
  return {
    zone: 'apps.example.com',
    serial: 9,
    ttl: 30,
    soa: { mname: 'ns1.apps.example.com', rname: 'hostmaster.apps.example.com', refresh: 7200, retry: 3600, expire: 1209600, minimum: 30 },
    nameservers: [{ label: 'ns1', fqdn: 'ns1.apps.example.com', ip: UK, nodeId: 'node-uk' }],
    geoRecords: [
      { host: 'web-shop.apps.example.com', maxAnswers: 1, endpoints, source: 'route' },
      { host: `api-shop.${ZA.replace(/\./g, '-')}.apps.example.com`, maxAnswers: 1, endpoints, source: 'route' },
    ],
    staticRecords: [{ name: '*', type: 'TXT', value: 'wild' }],
    synth: { ips: [UK, ZA, '10.0.0.5'] },
    ...overrides,
  };
}

describe('cluster zone — route names', () => {
  it('<svc>-<stack>.<zone> answers the nearest healthy edge, steered', () => {
    const fromZa = answerQuery([zone()], q('web-shop.apps.example.com', 'A'), za);
    expect(fromZa).toMatchObject({ rcode: 'NOERROR', aa: true, steered: true });
    expect(fromZa.answers.map(data)).toEqual([ZA]);
    expect(answerQuery([zone()], q('web-shop.apps.example.com', 'A'), uk).answers.map(data)).toEqual([UK]);
  });

  it('a route under an IP label is steered too — the route beats synthesis', () => {
    const fromUk = answerQuery([zone()], q('api-shop.41-76-108-20.apps.example.com', 'A'), uk);
    expect(fromUk.answers.map(data)).toEqual([UK]);
    expect(fromUk.steered).toBe(true);
  });

  it('a route with no endpoints yet falls back to its embedded IP, never empty', () => {
    const bare = zone({ geoRecords: [{ host: 'api-shop.41-76-108-20.apps.example.com', maxAnswers: 2, endpoints: [] }] });
    expect(answerQuery([bare], q('api-shop.41-76-108-20.apps.example.com', 'A'), uk).answers.map(data)).toEqual([ZA]);
  });
});

describe('cluster zone — <a-b-c-d> synthesis', () => {
  it('answers A for the IP label and any name beneath it', () => {
    for (const name of ['5-9-10-200.apps.example.com', 'swarmy.5-9-10-200.apps.example.com', 'S3.5-9-10-200.Apps.Example.com']) {
      const res = answerQuery([zone()], q(name, 'A'), uk);
      expect(res).toMatchObject({ rcode: 'NOERROR', aa: true, steered: false });
      expect(res.answers).toEqual([{ name: name.toLowerCase(), type: 'A', ttl: 30, data: UK }]);
    }
  });

  it('beats a wildcard: the IP label is the more specific claim', () => {
    expect(answerQuery([zone()], q('5-9-10-200.apps.example.com', 'A'), uk).answers.map(data)).toEqual([UK]);
    expect(answerQuery([zone()], q('5-9-10-200.apps.example.com', 'TXT'), uk).answers).toEqual([]);
  });

  it('AAAA and other types are NODATA (IPv4 only), not NXDOMAIN', () => {
    for (const type of ['AAAA', 'MX', 'TXT', 'CAA']) {
      const res = answerQuery([zone()], q('swarmy.5-9-10-200.apps.example.com', type), uk);
      expect(res.rcode).toBe('NOERROR');
      expect(res.answers).toEqual([]);
      expect(res.authorities[0]?.type).toBe('SOA');
    }
  });

  it('refuses private and foreign addresses: they fall through to the wildcard / NXDOMAIN', () => {
    const noWild = zone({ staticRecords: [] });
    expect(answerQuery([noWild], q('10-0-0-5.apps.example.com', 'A'), uk).rcode).toBe('NXDOMAIN'); // private, even listed
    expect(answerQuery([noWild], q('8-8-8-8.apps.example.com', 'A'), uk).rcode).toBe('NXDOMAIN'); // not ours
    expect(answerQuery([zone()], q('8-8-8-8.apps.example.com', 'TXT'), uk).answers.map(data)).toEqual(['wild']);
  });

  it('only on the cluster zone: no synth block, no synthesis', () => {
    const plain = zone({ synth: undefined, staticRecords: [] });
    expect(answerQuery([plain], q('5-9-10-200.apps.example.com', 'A'), uk).rcode).toBe('NXDOMAIN');
  });

  it('a static record at the name wins over synthesis', () => {
    const pinned = zone({ staticRecords: [{ name: '5-9-10-200', type: 'CNAME', value: 'elsewhere.example.net' }] });
    const res = answerQuery([pinned], q('5-9-10-200.apps.example.com', 'A'), uk);
    expect(res.answers.map((a) => a.type)).toEqual(['CNAME']);
  });
});
