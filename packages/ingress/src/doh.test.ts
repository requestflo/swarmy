import { describe, expect, it } from 'bun:test';
import { base64Url, decodeDnsResponse, dohRequest, encodeDnsQuery, ipv6Text, parseDohResolvers } from './doh';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('encodeDnsQuery (RFC 1035 message, RFC 8484 ID 0)', () => {
  it('golden bytes: www.example.com A', () => {
    expect([...encodeDnsQuery('www.example.com', 'A')]).toEqual([
      0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      3, ...ascii('www'), 7, ...ascii('example'), 3, ...ascii('com'), 0,
      0x00, 0x01, 0x00, 0x01,
    ]);
  });
  it('matches the RFC 8484 §4.1.1 example once base64url-encoded', () => {
    expect(base64Url(encodeDnsQuery('www.example.com.', 'A'))).toBe('AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB');
  });
  it('AAAA qtype is 28; names are lowercased', () => {
    const q = encodeDnsQuery('Shop.Acme.COM', 'AAAA');
    expect([...q.slice(-4)]).toEqual([0x00, 0x1c, 0x00, 0x01]);
    expect(String.fromCharCode(...q.slice(13, 17))).toBe('shop');
  });
  it('rejects an empty or over-long label', () => {
    expect(() => encodeDnsQuery('a..b', 'A')).toThrow();
    expect(() => encodeDnsQuery(`${'x'.repeat(64)}.com`, 'A')).toThrow();
  });
});

describe('decodeDnsResponse', () => {
  // www.example.com → CNAME edge.example.com → A 203.0.113.10, AAAA 2001:db8::10 (name compression throughout).
  const RESPONSE = Uint8Array.from([
    0x00, 0x00, 0x81, 0x80, 0x00, 0x01, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00,
    3, ...ascii('www'), 7, ...ascii('example'), 3, ...ascii('com'), 0, 0x00, 0x01, 0x00, 0x01,
    // CNAME: name → ptr 12, type 5, class 1, ttl 300, rdlen 7, "edge" + ptr 16 (example.com)
    0xc0, 0x0c, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x07, 4, ...ascii('edge'), 0xc0, 0x10,
    // A: name → ptr 45 (edge.example.com in the CNAME rdata), ttl 30
    0xc0, 0x2d, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1e, 0x00, 0x04, 203, 0, 113, 10,
    // AAAA 2001:db8::10
    0xc0, 0x2d, 0x00, 0x1c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1e, 0x00, 0x10,
    0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x10,
  ]);

  it('reads A / AAAA / CNAME answers (the wire twin of parseDohJson)', () => {
    expect(decodeDnsResponse(RESPONSE, 'quad9')).toEqual({
      resolver: 'quad9',
      a: ['203.0.113.10'],
      aaaa: ['2001:db8::10'],
      cname: ['edge.example.com'],
    });
  });
  it('maps NXDOMAIN / SERVFAIL / REFUSED', () => {
    const withRcode = (rcode: number) => Uint8Array.from([0, 0, 0x81, 0x80 | rcode, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeDnsResponse(withRcode(3), 'q')).toEqual({ resolver: 'q', a: [], aaaa: [], cname: [], nxdomain: true });
    expect(decodeDnsResponse(withRcode(2), 'q').error).toBe('SERVFAIL');
    expect(decodeDnsResponse(withRcode(5), 'q').error).toBe('DNS status 5');
  });
  it('garbage, truncation, a query echoed back and a pointer loop are errors, never throws', () => {
    expect(decodeDnsResponse(Uint8Array.from([1, 2, 3]), 'q').error).toBe('malformed DNS response');
    expect(decodeDnsResponse(RESPONSE.slice(0, RESPONSE.length - 5), 'q').error).toBe('malformed DNS response');
    expect(decodeDnsResponse(encodeDnsQuery('a.com', 'A'), 'q').error).toBe('malformed DNS response');
    const loop = Uint8Array.from([0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]);
    expect(decodeDnsResponse(loop, 'q').error).toBe('malformed DNS response');
  });
});

describe('ipv6Text (RFC 5952)', () => {
  const v6 = (...groups: number[]) => Uint8Array.from(groups.flatMap((g) => [g >> 8, g & 0xff]));
  it('compresses the longest zero run, lowercase, no leading zeros', () => {
    expect(ipv6Text(v6(0x2001, 0xdb8, 0, 0, 1, 0, 0, 1))).toBe('2001:db8::1:0:0:1');
    expect(ipv6Text(v6(0x2606, 0x4700, 0, 0, 0, 0, 0x6810, 0x84e5))).toBe('2606:4700::6810:84e5');
    expect(ipv6Text(v6(0, 0, 0, 0, 0, 0, 0, 1))).toBe('::1');
    expect(ipv6Text(v6(0x2001, 0xdb8, 0, 1, 1, 1, 1, 1))).toBe('2001:db8:0:1:1:1:1:1');
  });
});

describe('parseDohResolvers (SWARMY_DOH_RESOLVERS)', () => {
  it('unset → the 12 catalogue presets, Cloudflare and Google over JSON, the rest over RFC 8484', () => {
    const rs = parseDohResolvers(undefined);
    expect(rs).toHaveLength(12);
    expect(rs.slice(0, 3)).toEqual([
      { id: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query', format: 'json' },
      { id: 'google', url: 'https://dns.google/resolve', format: 'json' },
      { id: 'quad9', url: 'https://dns.quad9.net/dns-query', format: 'wire' },
    ]);
    expect(rs.filter((r) => r.format === 'json').map((r) => r.id)).toEqual(['cloudflare', 'google']);
  });
  it('empty / off / none → no public resolvers', () => {
    expect(parseDohResolvers('')).toEqual([]);
    expect(parseDohResolvers('OFF')).toEqual([]);
    expect(parseDohResolvers(' none ')).toEqual([]);
  });
  it('presets by id, custom https URLs (JSON by default, wire: prefix), junk ignored, duplicates dropped', () => {
    const rs = parseDohResolvers('Google, quad9, https://doh.internal/dns-query, wire:https://doh2.internal/q, http://insecure/x, nonsense, google');
    expect(rs).toEqual([
      { id: 'google', url: 'https://dns.google/resolve', format: 'json' },
      { id: 'quad9', url: 'https://dns.quad9.net/dns-query', format: 'wire' },
      { id: 'doh.internal', url: 'https://doh.internal/dns-query', format: 'json' },
      { id: 'doh2.internal', url: 'https://doh2.internal/q', format: 'wire' },
    ]);
  });
});

describe('dohRequest', () => {
  it('JSON: ?name=&type= with accept dns-json', () => {
    expect(dohRequest({ id: 'google', url: 'https://dns.google/resolve', format: 'json' }, 'a.example.com', 'AAAA')).toEqual({
      url: 'https://dns.google/resolve?name=a.example.com&type=AAAA',
      accept: 'application/dns-json',
    });
  });
  it('wire: ?dns=<base64url> with accept dns-message (appends to an existing query)', () => {
    expect(dohRequest({ id: 'x', url: 'https://doh.internal/q?profile=1', format: 'wire' }, 'www.example.com', 'A')).toEqual({
      url: 'https://doh.internal/q?profile=1&dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB',
      accept: 'application/dns-message',
    });
  });
});
