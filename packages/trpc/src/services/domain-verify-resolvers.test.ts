import { describe, expect, it } from 'bun:test';
import type { ResolverAnswer } from '@swarmy/ingress';
import {
  classicLookup,
  parseDohResolvers,
  resolverChainLookup,
  type ClassicResolver,
} from './domain-verify.service';

const err = (code: string) => Object.assign(new Error(code), { code });

function fakeResolver(a: string[] | string, aaaa: string[] | string = 'ENODATA'): ClassicResolver {
  const r = (v: string[] | string) => (typeof v === 'string' ? Promise.reject(err(v)) : Promise.resolve(v));
  return { resolve4: () => r(a), resolve6: () => r(aaaa) };
}

const EXPECTED = { ips: ['203.0.113.10'] };

describe('parseDohResolvers (SWARMY_DOH_RESOLVERS)', () => {
  it('defaults to the two public presets', () => {
    expect(parseDohResolvers(undefined).map((r) => r.name)).toEqual(['1.1.1.1', '8.8.8.8']);
  });
  it('empty / off / none means system resolver only', () => {
    expect(parseDohResolvers('')).toEqual([]);
    expect(parseDohResolvers('off')).toEqual([]);
    expect(parseDohResolvers(' none ')).toEqual([]);
  });
  it('accepts presets and https URLs, ignores junk and plain http', () => {
    const rs = parseDohResolvers('google, https://doh.internal/dns-query, http://insecure/x, nonsense');
    expect(rs.map((r) => r.name)).toEqual(['8.8.8.8', 'doh.internal']);
    expect(rs[1]!.url('a.example.com', 'A')).toBe('https://doh.internal/dns-query?name=a.example.com&type=A');
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

  it('skips the public round-trip when the local view already says "not us"', async () => {
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
    expect(dohCalled).toBe(false);
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
