import { describe, expect, it } from 'bun:test';
import { encodeDnsQuery, evaluateDns, type ResolverAnswer } from '@swarmy/ingress';
import {
  classicLookup,
  dohLookup,
  parseDohResolvers,
  resolverChainLookup,
  toResolverView,
  type ClassicResolver,
} from './domain-verify.service';

const err = (code: string) => Object.assign(new Error(code), { code });

function fakeResolver(a: string[] | string, aaaa: string[] | string = 'ENODATA'): ClassicResolver {
  const r = (v: string[] | string) => (typeof v === 'string' ? Promise.reject(err(v)) : Promise.resolve(v));
  return { resolve4: () => r(a), resolve6: () => r(aaaa) };
}

const EXPECTED = { ips: ['203.0.113.10'] };

describe('parseDohResolvers (SWARMY_DOH_RESOLVERS)', () => {
  it('defaults to the 12 public presets', () => {
    expect(parseDohResolvers(undefined).map((r) => r.id)).toEqual([
      'cloudflare', 'google', 'quad9', 'opendns', 'adguard', 'mullvad', 'controld', 'cira', 'alidns', 'dnspod', 'quad101', 'iij',
    ]);
  });
  it('empty / off / none means system resolver only', () => {
    expect(parseDohResolvers('')).toEqual([]);
    expect(parseDohResolvers('off')).toEqual([]);
    expect(parseDohResolvers(' none ')).toEqual([]);
  });
});

/** A fetch double: answers per (host, qtype) from a table; `hang` never settles. */
function fakeFetch(answers: Record<string, 'hang' | 'fail' | number | { json?: unknown; wire?: Uint8Array }>) {
  const asked: Array<{ url: string; accept?: string }> = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    asked.push({ url, accept: init?.headers?.accept });
    const u = new URL(url);
    const a = answers[u.host];
    if (a === undefined || a === 'hang') return new Promise<never>(() => undefined);
    if (a === 'fail') throw new TypeError('fetch failed');
    if (typeof a === 'number') return { ok: false, status: a, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      json: async () => a.json,
      arrayBuffer: async () => (a.wire ? a.wire.slice().buffer : new ArrayBuffer(0)),
    };
  };
  return { impl, asked };
}

/** A wire response answering the query with one A record (name → pointer to the question). */
function wireA(name: string, ip: number[]): Uint8Array {
  const q = encodeDnsQuery(name, 'A');
  const out = Uint8Array.from([...q, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...ip]);
  out[2] = 0x81;
  out[3] = 0x80;
  out[7] = 1;
  return out;
}

describe('dohLookup — parallel, both formats, a hard deadline', () => {
  const eps = parseDohResolvers('cloudflare, quad9, wire:https://slow.example/dns-query, https://down.example/q, https://err.example/q');

  it('asks JSON and wire resolvers in their format and folds the answers', async () => {
    const f = fakeFetch({
      'cloudflare-dns.com': { json: { Status: 0, Answer: [{ type: 1, data: '203.0.113.10' }] } },
      'dns.quad9.net': { wire: wireA('app.example.com', [203, 0, 113, 10]) },
      'slow.example': 'hang',
      'down.example': 'fail',
      'err.example': 503,
    });
    const started = Date.now();
    const out = await dohLookup('app.example.com', f.impl, eps, 60);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.map((a) => [a.resolver, a.a, a.error ?? null])).toEqual([
      ['cloudflare', ['203.0.113.10'], null],
      ['quad9', ['203.0.113.10'], null],
      ['slow.example', [], 'timed out'],
      ['down.example', [], 'fetch failed'],
      ['err.example', [], 'HTTP 503'],
    ]);
    const cf = f.asked.find((x) => x.url.includes('cloudflare'))!;
    expect(cf).toEqual({ url: 'https://cloudflare-dns.com/dns-query?name=app.example.com&type=A', accept: 'application/dns-json' });
    const q9 = f.asked.find((x) => x.url.includes('quad9'))!;
    expect(q9.accept).toBe('application/dns-message');
    expect(q9.url).toStartWith('https://dns.quad9.net/dns-query?dns=');
    // A + AAAA per resolver, all at once.
    expect(f.asked).toHaveLength(10);
    // The silent ones leave the count; the HTTP error shows as an error.
    const obs = evaluateDns('app.example.com', out, { ips: ['203.0.113.10'] });
    expect(obs.gate).toMatchObject({ agreeing: 2, answering: 2, pass: true });
    expect(obs.resolvers!.map((r) => r.state)).toEqual(['agrees', 'agrees', 'no_answer', 'no_answer', 'error']);
  });
});

describe('toResolverView', () => {
  it('adds the catalogue name, operator and home city; maps legacy ids', () => {
    expect(toResolverView({ resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: [], matches: true })).toEqual({
      id: 'google',
      name: 'Google 8.8.8.8',
      operator: 'Google',
      city: 'Mountain View',
      region: 'North America',
      lat: 37.39,
      lon: -122.08,
      tier: 'public',
      format: 'json',
      url: 'https://dns.google/resolve',
      anchor: true,
      state: 'agrees',
      ips: ['203.0.113.10'],
      cname: [],
      nxdomain: false,
      error: null,
    });
    expect(toResolverView({ resolver: 'system', a: ['198.51.100.7'], aaaa: [], cname: [], matches: false })).toMatchObject({
      name: 'swarmy’s own resolver',
      tier: 'local',
      state: 'cached',
      city: null,
    });
  });
});

describe('classicLookup', () => {
  it('merges A + AAAA', async () => {
    const a = await classicLookup('x.example', 'system', fakeResolver(['203.0.113.10'], ['2001:DB8::1']));
    expect(a).toMatchObject({ resolver: 'system', a: ['203.0.113.10'], aaaa: ['2001:db8::1'] });
    expect(a.error).toBeUndefined();
  });
  it('NXDOMAIN is an answer, a timeout is an error', async () => {
    expect((await classicLookup('x', 'system', fakeResolver('ENOTFOUND', 'ENOTFOUND'))).nxdomain).toBe(true);
    expect((await classicLookup('x', 'system', fakeResolver('ETIMEOUT', 'ETIMEOUT'))).error).toBe('ETIMEOUT');
  });
});

describe('resolverChainLookup — system → swarmy-dns → public DoH', () => {
  const dohOk = async (): Promise<ResolverAnswer[]> => [{ resolver: '1.1.1.1', a: ['203.0.113.10'], aaaa: [], cname: [] }];
  const dohOffline = async (): Promise<ResolverAnswer[]> => [
    { resolver: '1.1.1.1', a: [], aaaa: [], cname: [], error: 'fetch failed' },
  ];

  it('asks the system resolver first and swarmy-dns for in-zone hosts', async () => {
    const asked: Array<readonly string[] | undefined> = [];
    const out = await resolverChainLookup('app.example.com', EXPECTED, {
      swarmyDnsServers: ['198.51.100.1'],
      io: {
        resolver: async (servers) => {
          asked.push(servers);
          return fakeResolver(['203.0.113.10']);
        },
        doh: dohOk,
      },
    });
    expect(asked).toEqual([undefined, ['198.51.100.1']]);
    expect(out.map((a) => a.resolver)).toEqual(['system', 'swarmy-dns', '1.1.1.1']);
  });

  it('always asks the public resolvers too (the map), even when the local view sees another address', async () => {
    let dohCalled = false;
    const out = await resolverChainLookup('app.example.com', EXPECTED, {
      io: {
        resolver: async () => fakeResolver(['192.0.2.99']),
        doh: async () => {
          dohCalled = true;
          return [];
        },
      },
    });
    expect(dohCalled).toBe(true);
    expect(out.map((a) => a.resolver)).toEqual(['system']);
  });

  it('offline public resolvers are carried as errors (ignored by evaluateDns), never block', async () => {
    const out = await resolverChainLookup('app.example.com', EXPECTED, {
      io: { resolver: async () => fakeResolver(['203.0.113.10']), doh: dohOffline },
    });
    expect(out.filter((a) => !a.error).map((a) => a.resolver)).toEqual(['system']);
  });

  it('falls through to DoH when the system resolver fails', async () => {
    const out = await resolverChainLookup('app.example.com', EXPECTED, {
      io: { resolver: async () => fakeResolver('ECONNREFUSED', 'ECONNREFUSED'), doh: dohOk },
    });
    expect(out.map((a) => [a.resolver, Boolean(a.error)])).toEqual([
      ['system', true],
      ['1.1.1.1', false],
    ]);
  });
});
