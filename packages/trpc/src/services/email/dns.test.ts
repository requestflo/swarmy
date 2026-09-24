import { describe, expect, it } from 'bun:test';
import {
  addressDomain,
  bareAddress,
  checkEmailDns,
  emailDnsRecords,
  emailZoneRecords,
  normalizeEmailDomain,
  spfValue,
  type EmailDomainDnsInput,
} from './dns';

const direct: EmailDomainDnsInput = {
  domain: 'example.com',
  selector: 'swarmy',
  dkimPublicKey: 'MIIBKEY',
  delivery: 'direct',
  sendingIps: ['203.0.113.7'],
  dmarcPolicy: 'none',
  heloHost: 'mail.example.com',
};
const relay: EmailDomainDnsInput = { ...direct, domain: 'shop.example.com', delivery: 'relay', relaySpfInclude: 'spf.relay.test' };

describe('emailDnsRecords', () => {
  it('direct delivery: DKIM, SPF with the mail node IP, DMARC, and the HELO A record', () => {
    expect(emailDnsRecords(direct).map((r) => [r.kind, r.name, r.type, r.value])).toEqual([
      ['dkim', 'swarmy._domainkey.example.com', 'TXT', 'v=DKIM1; k=rsa; p=MIIBKEY'],
      ['spf', 'example.com', 'TXT', 'v=spf1 ip4:203.0.113.7 ~all'],
      ['dmarc', '_dmarc.example.com', 'TXT', 'v=DMARC1; p=none; adkim=r; aspf=r'],
      ['helo', 'mail.example.com', 'A', '203.0.113.7'],
    ]);
  });

  it('relay delivery: SPF includes the provider, no HELO record', () => {
    const rs = emailDnsRecords(relay);
    expect(rs.find((r) => r.kind === 'spf')?.value).toBe('v=spf1 include:spf.relay.test ~all');
    expect(rs.some((r) => r.kind === 'helo')).toBe(false);
  });

  it('IPv6 sending IPs become ip6: and AAAA', () => {
    const rs = emailDnsRecords({ ...direct, sendingIps: ['2001:db8::1'] });
    expect(rs.find((r) => r.kind === 'spf')?.value).toBe('v=spf1 ip6:2001:db8::1 ~all');
    expect(rs.find((r) => r.kind === 'helo')?.type).toBe('AAAA');
  });

  it('only DKIM is required (it is the verification gate)', () => {
    expect(emailDnsRecords(direct).filter((r) => r.required).map((r) => r.kind)).toEqual(['dkim']);
  });

  it('spfValue with no mechanisms still ends in ~all', () => {
    expect(spfValue([])).toBe('v=spf1 ~all');
  });
});

describe('emailZoneRecords (derived into a swarmy-dns zone)', () => {
  it('renders zone-relative records for domains inside the zone only', () => {
    const recs = emailZoneRecords('example.com', [direct, relay, { ...direct, domain: 'other.org' }]);
    expect(recs).toContainEqual({ name: 'swarmy._domainkey', type: 'TXT', value: 'v=DKIM1; k=rsa; p=MIIBKEY' });
    expect(recs).toContainEqual({ name: '@', type: 'TXT', value: 'v=spf1 ip4:203.0.113.7 ~all' });
    expect(recs).toContainEqual({ name: '_dmarc.shop', type: 'TXT', value: 'v=DMARC1; p=none; adkim=r; aspf=r' });
    expect(recs).toContainEqual({ name: 'mail', type: 'A', value: '203.0.113.7' });
    expect(recs.some((r) => r.name.includes('other'))).toBe(false);
  });

  it('never publishes a second SPF record next to a manual one', () => {
    const recs = emailZoneRecords('example.com', [direct], [{ name: '@', type: 'TXT', value: 'v=spf1 include:_spf.google.com ~all' }]);
    expect(recs.some((r) => r.name === '@' && r.value.startsWith('v=spf1'))).toBe(false);
    expect(recs.some((r) => r.name === 'swarmy._domainkey')).toBe(true);
  });
});

function lookups(txt: Record<string, string[]>, a: Record<string, string[]> = {}) {
  return {
    txt: async (n: string) => txt[n] ?? [],
    addresses: async (n: string) => a[n] ?? [],
  };
}

describe('checkEmailDns (guided checks for domains hosted elsewhere)', () => {
  it('all present → ok, dkimOk sets the gate', async () => {
    const c = await checkEmailDns(
      direct,
      lookups(
        {
          'swarmy._domainkey.example.com': ['v=DKIM1; k=rsa; p=MIIBKEY'],
          'example.com': ['v=spf1 ip4:203.0.113.7 include:_spf.google.com ~all', 'google-site-verification=x'],
          '_dmarc.example.com': ['v=DMARC1; p=reject'],
        },
        { 'mail.example.com': ['203.0.113.7'] },
      ),
    );
    expect(c.records.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(c.dkimOk).toBe(true);
    expect(c.allOk).toBe(true);
  });

  it('missing records say exactly what to add', async () => {
    const c = await checkEmailDns(direct, lookups({}));
    expect(c.dkimOk).toBe(false);
    const spf = c.records.find((r) => r.kind === 'spf')!;
    expect(spf.status).toBe('missing');
    expect(spf.hint).toContain('v=spf1 ip4:203.0.113.7 ~all');
  });

  it('an existing SPF without our IP is a mismatch with a merge hint; two SPF records is an error', async () => {
    const one = await checkEmailDns(direct, lookups({ 'example.com': ['v=spf1 include:_spf.google.com ~all'] }));
    const spf = one.records.find((r) => r.kind === 'spf')!;
    expect(spf.status).toBe('mismatch');
    expect(spf.hint).toContain('ip4:203.0.113.7');
    const two = await checkEmailDns(direct, lookups({ 'example.com': ['v=spf1 ~all', 'v=spf1 -all'] }));
    expect(two.records.find((r) => r.kind === 'spf')!.hint).toContain('several SPF records');
  });

  it('a different DKIM key under our selector is a mismatch (not a pass)', async () => {
    const c = await checkEmailDns(direct, lookups({ 'swarmy._domainkey.example.com': ['v=DKIM1; k=rsa; p=OTHER'] }));
    expect(c.records[0]!.status).toBe('mismatch');
    expect(c.dkimOk).toBe(false);
  });

  it('lookup failures are errors, not "missing"', async () => {
    const c = await checkEmailDns(direct, { txt: async () => Promise.reject(new Error('SERVFAIL')), addresses: async () => [] });
    expect(c.records[0]!.status).toBe('error');
  });
});

describe('address helpers', () => {
  it('normalise domains and addresses', () => {
    expect(normalizeEmailDomain(' Example.COM. ')).toBe('example.com');
    expect(() => normalizeEmailDomain('not a domain')).toThrow();
    expect(addressDomain('App <NoReply@Example.com>')).toBe('example.com');
    expect(bareAddress('App <NoReply@Example.com>')).toBe('noreply@example.com');
    expect(addressDomain('nope')).toBeNull();
  });
});
