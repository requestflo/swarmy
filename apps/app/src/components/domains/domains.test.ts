import { describe, expect, it } from 'bun:test';
import type { DomainPlan } from '@/components/ingress/domain-state';
import { hostKind, wwwExample, companionOf } from './host-shape';
import { planRows, planTitle } from './plan-records';
import { cadenceCopy, checkClock, railState } from './lifecycle';
import { diagnose } from './diagnosis';
import { gateOf, railDnsLines } from './resolver-words';
import type { DnsGate } from '@/components/ingress/domain-state';

const plan = (host: string, label: string): DomainPlan => ({
  host,
  apex: 'northwind.shop',
  isApex: label === '@',
  registrar: {
    mode: 'records',
    summary: '',
    records: [
      { type: 'A', name: host, label, value: '203.0.113.10' },
      { type: 'A', name: host, label, value: '198.51.100.10' },
    ],
    alternatives: [],
  },
  nameserver: null,
  edges: [
    { ip: '203.0.113.10', name: 'mgr-1', region: 'us-east' },
    { ip: '198.51.100.10', name: 'mgr-2', region: 'eu-west' },
  ],
});

describe('host shape', () => {
  it('tells apex, subdomain and wildcard apart (two-label suffixes too)', () => {
    expect(hostKind('northwind.shop')).toBe('apex');
    expect(hostKind('go.northwind.shop')).toBe('subdomain');
    expect(hostKind('shop.co.uk')).toBe('apex');
    expect(hostKind('*.northwind.shop')).toBe('wildcard');
    expect(hostKind('nope')).toBeNull();
  });
  it('pairs www both ways and says what the redirect does', () => {
    expect(companionOf('www.northwind.shop')).toBe('northwind.shop');
    expect(wwwExample('northwind.shop', 'redirect-www-to-apex')).toBe('www.northwind.shop → 308 → https://northwind.shop');
    expect(wwwExample('northwind.shop', 'none')).toBe('only northwind.shop · www.northwind.shop won’t answer');
  });
});

describe('planRows', () => {
  it('names the edge beside each address and adds a www CNAME that follows the apex', () => {
    const rows = planRows(plan('northwind.shop', '@'), 'registrar', 'redirect-www-to-apex');
    expect(rows.map((r) => [r.type, r.label, r.value, r.note])).toEqual([
      ['A', '@', '203.0.113.10', 'mgr-1'],
      ['A', '@', '198.51.100.10', 'mgr-2'],
      ['CNAME', 'www', 'northwind.shop.', 'follows the apex'],
    ]);
    expect(planTitle(rows, 'registrar', null, 'Namecheap')).toBe('Add 3 records at Namecheap');
  });
  it('gives the apex its own A records when the typed host is www', () => {
    const rows = planRows(plan('www.northwind.shop', 'www'), 'registrar', 'redirect-apex-to-www');
    expect(rows.filter((r) => r.label === '@').length).toBe(2);
  });
});

describe('lifecycle', () => {
  it('puts the rail on the right step', () => {
    expect(railState({ state: 'waiting_dns', verifiedAt: null, certificate: null })).toEqual({ current: 0, failed: false });
    expect(railState({ state: 'issuing', verifiedAt: 'x', certificate: null }).current).toBe(2);
    expect(railState({ state: 'active', verifiedAt: 'x', certificate: null }).current).toBe(4);
    const cert = { issuer: null, expiresAt: null, error: 'x', edges: [], checkedAt: null };
    expect(railState({ state: 'error', verifiedAt: 'x', certificate: cert })).toEqual({ current: 2, failed: true });
  });
  it('ticks the check clock from the real timestamps', () => {
    const now = Date.parse('2026-09-26T12:00:30Z');
    expect(checkClock({ lastCheckedAt: '2026-09-26T12:00:18Z', nextCheckAt: '2026-09-26T12:00:48Z' }, now)).toBe('last checked 12 s ago · next in 18 s');
    expect(checkClock({ lastCheckedAt: '2026-09-26T12:00:00Z', nextCheckAt: '2026-09-26T12:00:30Z' }, now)).toContain('due now');
  });
  it('says the real backoff', () => {
    expect(cadenceCopy('waiting_dns', false)).toContain('every 30 s for the first 10 minutes');
    expect(cadenceCopy('waiting_dns', false)).toContain('hourly after a day');
    expect(cadenceCopy('active', true)).toContain('every 10 minutes');
  });
});

describe('diagnose', () => {
  const base = { state: 'waiting_dns' as const, warnings: [], gated: true, verifiedAt: null };
  it('turns a Cloudflare proxy into the grey-cloud fix', () => {
    const g = diagnose({ ...base, reason: 'a.com resolves to Cloudflare’s proxy (104.21.3.4). Set the record to “DNS only”…' });
    expect(g.headline).toBe('It resolves to Cloudflare’s proxy, not your servers.');
    expect(g.fix).toContain('grey');
  });
  it('keeps a wrong-IP reason and says swarmy waits', () => {
    const g = diagnose({ ...base, reason: 'northwind.shop points at 192.64.119.20 — expected 203.0.113.10.' });
    expect(g.headline).toBe('northwind.shop points at 192.64.119.20 — expected 203.0.113.10');
    expect(g.gate).toContain('won’t ask for a certificate until DNS points here');
  });
  it('explains an AAAA record', () => {
    const g = diagnose({ ...base, reason: 'An AAAA record points a.com at 2606:4700::1. Let’s Encrypt tries IPv6 first, so remove it.' });
    expect(g.fix).toContain('Delete the AAAA record');
  });
});

describe('resolver words (the 3-in-4 gate on the rail)', () => {
  const gate = (over: Partial<DnsGate> = {}): DnsGate => ({ basis: 'public', agreeing: 7, answering: 12, needed: 9, anchors: ['1.1.1.1', '8.8.8.8'], anchorsAgree: false, pass: false, ...over });
  it('waiting: "7 of 12 resolvers" · "needs 9 of 12, including 1.1.1.1 and 8.8.8.8"', () => {
    expect(railDnsLines(gate(), false)).toEqual(['7 of 12 resolvers', 'needs 9 of 12, including 1.1.1.1 and 8.8.8.8']);
  });
  it('verified: "9 of 12 agree, including 1.1.1.1 and 8.8.8.8"', () => {
    expect(railDnsLines(gate({ agreeing: 9, anchorsAgree: true, pass: true }), false)[1]).toBe('9 of 12 agree, including 1.1.1.1 and 8.8.8.8');
  });
  it('a custom list without anchors, the local fallback and an admin skip', () => {
    expect(railDnsLines(gate({ agreeing: 3, answering: 4, needed: 3, anchors: [], pass: true }), false)[1]).toBe('3 of 4 agree');
    expect(railDnsLines(gate({ basis: 'local', agreeing: 1, answering: 1, needed: 1, pass: true }), false)[1]).toBe('swarmy’s own resolvers agree');
    expect(railDnsLines(null, true)).toEqual(['skipped by an admin', 'without a DNS check']);
  });
  it('gateOf derives counts for records from before the gate was kept', () => {
    const r = (state: 'agrees' | 'cached' | 'no_answer') => ({ state, error: state === 'no_answer' ? 'timeout' : null }) as never;
    expect(gateOf({ dns: { a: [], aaaa: [], cname: [], matched: [], resolvers: [r('agrees'), r('cached'), r('no_answer')], gate: null } })).toMatchObject({
      agreeing: 1,
      answering: 2,
      pass: false,
    });
  });
});
