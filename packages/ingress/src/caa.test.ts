import { describe, expect, it } from 'bun:test';
import { caaLookupNames, evaluateCaa, type CaaLookup, type CaaRecord } from './caa';

const LE = { name: "Let's Encrypt", caa: 'letsencrypt.org' };
const rec = (tag: string, value: string, critical = 0): CaaRecord => ({ critical, tag, value });
/** The lookups for `host` from a little zone: name → records (missing = none), or an error string. */
function walk(host: string, zone: Record<string, CaaRecord[] | string>): CaaLookup[] {
  const out: CaaLookup[] = [];
  for (const name of caaLookupNames(host)) {
    const z = zone[name];
    if (typeof z === 'string') return [...out, { name, error: z }];
    out.push({ name, records: z ?? [] });
    if (z?.length) break;
  }
  return out;
}

describe('caaLookupNames (the tree climb)', () => {
  it('the host, then each parent, never the root; a wildcard starts at its base', () => {
    expect(caaLookupNames('shop.northwind.dev')).toEqual(['shop.northwind.dev', 'northwind.dev', 'dev']);
    expect(caaLookupNames('*.northwind.dev')).toEqual(['northwind.dev', 'dev']);
    expect(caaLookupNames('Shop.Northwind.dev.')).toEqual(['shop.northwind.dev', 'northwind.dev', 'dev']);
  });
});

describe('evaluateCaa', () => {
  it('no records anywhere → any CA may issue', () => {
    const v = evaluateCaa('shop.northwind.dev', walk('shop.northwind.dev', {}), LE);
    expect(v.state).toBe('open');
    expect(v.at).toBeNull();
    expect(v.say).toBe("No CAA records for it or its parents, so any certificate authority may issue, Let's Encrypt included.");
  });

  it('the first non-empty set up the tree decides: the parent allows Let’s Encrypt', () => {
    const v = evaluateCaa('shop.northwind.dev', walk('shop.northwind.dev', { 'northwind.dev': [rec('issue', 'letsencrypt.org'), rec('iodef', 'mailto:ops@northwind.dev')] }), LE);
    expect(v).toMatchObject({ state: 'allowed', at: 'northwind.dev', allowed: ['letsencrypt.org'], caveats: [] });
    expect(v.say).toBe("CAA at northwind.dev lets Let's Encrypt issue (letsencrypt.org allowed).");
  });

  it('a closer set wins over a parent that would allow it', () => {
    const v = evaluateCaa('shop.northwind.dev', walk('shop.northwind.dev', {
      'shop.northwind.dev': [rec('issue', 'sectigo.com'), rec('issue', 'pki.goog; cansignhttpexchanges=yes')],
      'northwind.dev': [rec('issue', 'letsencrypt.org')],
    }), LE);
    expect(v.state).toBe('forbidden');
    expect(v.allowed).toEqual(['sectigo.com', 'pki.goog']);
    expect(v.say).toBe("CAA at shop.northwind.dev allows only sectigo.com, pki.goog, so Let's Encrypt cannot issue. Add 0 issue \"letsencrypt.org\" there.");
  });

  it('`issue ";"` forbids every CA; a set with only iodef forbids none', () => {
    expect(evaluateCaa('a.dev', [{ name: 'a.dev', records: [rec('issue', ';')] }], LE).say).toContain('allows no certificate authority');
    expect(evaluateCaa('a.dev', [{ name: 'a.dev', records: [rec('iodef', 'mailto:x@a.dev')] }], LE).state).toBe('open');
  });

  it('a wildcard reads issuewild when present, else issue', () => {
    const zone = { 'northwind.dev': [rec('issue', 'letsencrypt.org'), rec('issuewild', ';')] };
    expect(evaluateCaa('*.northwind.dev', walk('*.northwind.dev', zone), LE).state).toBe('forbidden');
    expect(evaluateCaa('shop.northwind.dev', walk('shop.northwind.dev', zone), LE).state).toBe('allowed');
    expect(evaluateCaa('*.northwind.dev', walk('*.northwind.dev', { 'northwind.dev': [rec('issue', 'letsencrypt.org')] }), LE).state).toBe('allowed');
  });

  it('an unknown critical property forbids all; an unknown non-critical one is ignored', () => {
    expect(evaluateCaa('a.dev', [{ name: 'a.dev', records: [rec('issue', 'letsencrypt.org'), rec('tbs', 'x', 128)] }], LE).state).toBe('forbidden');
    expect(evaluateCaa('a.dev', [{ name: 'a.dev', records: [rec('issue', 'letsencrypt.org'), rec('tbs', 'x')] }], LE).state).toBe('allowed');
  });

  it('allowed with conditions: a pinned account, validation methods the edge does not use', () => {
    const v = evaluateCaa('a.dev', [{ name: 'a.dev', records: [rec('issue', 'letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/1; validationmethods=dns-01')] }], LE);
    expect(v.state).toBe('allowed');
    expect(v.caveats).toEqual(["only the ACME account https://acme-v02.api.letsencrypt.org/acme/acct/1 may issue; it must be the front door's"]);
    const http = evaluateCaa('*.a.dev', [{ name: 'a.dev', records: [rec('issuewild', 'letsencrypt.org; validationmethods=http-01')] }], LE);
    expect(http.caveats).toEqual(['only http-01 validation is allowed, which the front door does not use for this name']);
  });

  it('a failed lookup is unknown, never "no records"', () => {
    const v = evaluateCaa('shop.northwind.dev', walk('shop.northwind.dev', { 'northwind.dev': 'SERVFAIL' }), LE);
    expect(v).toMatchObject({ state: 'unknown', at: 'northwind.dev' });
    expect(v.say).toBe("The CAA lookup at northwind.dev failed (SERVFAIL); Let's Encrypt will not issue until it answers.");
  });
});
