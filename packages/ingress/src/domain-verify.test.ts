import { describe, expect, it } from 'bun:test';
import {
  apexOf,
  applyCheck,
  certAlertFor,
  becameRenderable,
  certCoversHost,
  certFromProbes,
  dnsGuidance,
  domainState,
  evaluateDns,
  isCloudflareProxyIp,
  isHostGated,
  lookupNameFor,
  mergeAnswers,
  newDomainRecord,
  parseDohJson,
  planDomainChecks,
  ISSUE_GRACE_MS,
  type DomainCheckRecord,
  type HostPosture,
  type ResolverAnswer,
} from './domain-verify';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const EDGE = { ips: ['203.0.113.10', '2001:db8::10'] };
const ans = (resolver: string, a: string[] = [], aaaa: string[] = [], extra: Partial<ResolverAnswer> = {}): ResolverAnswer => ({
  resolver,
  a,
  aaaa,
  cname: [],
  ...extra,
});
const posture = (host: string, extra: Partial<HostPosture> = {}): HostPosture => ({
  host,
  tls: 'auto',
  private: false,
  tunnel: false,
  ...extra,
});

describe('parseDohJson', () => {
  it('reads A/AAAA/CNAME answers (Cloudflare/Google JSON format)', () => {
    const json = {
      Status: 0,
      Answer: [
        { name: 'shop.acme.com.', type: 5, TTL: 300, data: 'edge.acme.net.' },
        { name: 'edge.acme.net.', type: 1, TTL: 30, data: '203.0.113.10' },
        { name: 'edge.acme.net.', type: 28, TTL: 30, data: '2001:DB8::10' },
      ],
    };
    expect(parseDohJson(json, '1.1.1.1')).toEqual({
      resolver: '1.1.1.1',
      a: ['203.0.113.10'],
      aaaa: ['2001:db8::10'],
      cname: ['edge.acme.net'],
    });
  });
  it('maps NXDOMAIN / SERVFAIL / garbage', () => {
    expect(parseDohJson({ Status: 3 }, 'g').nxdomain).toBe(true);
    expect(parseDohJson({ Status: 2 }, 'g').error).toBe('SERVFAIL');
    expect(parseDohJson('nope', 'g').error).toBe('malformed DNS response');
  });
  it('mergeAnswers unions per-type lookups and keeps NXDOMAIN', () => {
    expect(mergeAnswers('c', [ans('c', ['1.2.3.4']), ans('c', [], ['::1'])])).toEqual({
      resolver: 'c',
      a: ['1.2.3.4'],
      aaaa: ['::1'],
      cname: [],
      nxdomain: false,
    });
    expect(mergeAnswers('c', [ans('c', [], [], { nxdomain: true }), ans('c', [], [], { nxdomain: true })]).nxdomain).toBe(true);
    expect(mergeAnswers('c', [ans('c', [], [], { error: 'timeout' })]).error).toBe('timeout');
  });
});

describe('evaluateDns', () => {
  it('ok when every resolver sees an edge', () => {
    const v = evaluateDns('shop.acme.com', [ans('1.1.1.1', ['203.0.113.10']), ans('8.8.8.8', ['203.0.113.10'])], EDGE);
    expect(v).toMatchObject({ ok: true, reason: null, warnings: [], matched: ['203.0.113.10'] });
  });
  it('matches IPv6 in any textual form', () => {
    expect(evaluateDns('a.com', [ans('c', [], ['2001:0db8:0000::0010'])], EDGE).ok).toBe(true);
  });
  it('waiting: no record yet', () => {
    const v = evaluateDns('shop.acme.com', [ans('c', [], [], { nxdomain: true })], EDGE);
    expect(v).toMatchObject({ ok: false, reason: 'No DNS record for shop.acme.com yet.' });
  });
  it('waiting: points elsewhere', () => {
    const v = evaluateDns('shop.acme.com', [ans('c', ['198.51.100.7'])], EDGE);
    expect(v.reason).toBe('shop.acme.com points at 198.51.100.7 — expected 203.0.113.10 or 2001:db8::10.');
  });
  it('explains Cloudflare orange-cloud proxying', () => {
    const v = evaluateDns('shop.acme.com', [ans('c', ['104.21.3.4', '172.67.1.2'])], EDGE);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('Cloudflare’s proxy');
  });
  it('propagating when one resolver still sees the old address', () => {
    const v = evaluateDns('a.com', [ans('1.1.1.1', ['203.0.113.10']), ans('8.8.8.8', ['198.51.100.7'])], EDGE);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('Still propagating: 8.8.8.8 sees 198.51.100.7.');
  });
  it('ignores a resolver that errored', () => {
    const v = evaluateDns('a.com', [ans('1.1.1.1', ['203.0.113.10']), ans('8.8.8.8', [], [], { error: 'timeout' })], EDGE);
    expect(v.ok).toBe(true);
  });
  it('blocks on a foreign AAAA (LE prefers IPv6)', () => {
    const v = evaluateDns('a.com', [ans('c', ['203.0.113.10'], ['2001:db8::99'])], { ips: ['203.0.113.10'] });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('AAAA record points a.com at 2001:db8::99');
  });
  it('warns (but verifies) on a stale extra A record', () => {
    const v = evaluateDns('a.com', [ans('c', ['203.0.113.10', '198.51.100.7'])], EDGE);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([
      'a.com also points at 198.51.100.7, which is not a swarmy edge — some visitors will land there. Remove the stale record.',
    ]);
  });
  it('all resolvers failed', () => {
    const v = evaluateDns('a.com', [ans('1.1.1.1', [], [], { error: 'timeout' })], EDGE);
    expect(v.reason).toBe('DNS lookup failed (1.1.1.1: timeout).');
  });
  it('no known edge IP', () => {
    expect(evaluateDns('a.com', [ans('c', ['1.2.3.4'])], { ips: [] }).reason).toContain('No ingress node has a known public IP');
  });
  it('tunnel: CNAME to cfargotunnel or proxied answers verify', () => {
    const t = { ips: [], tunnelCname: 'abc.cfargotunnel.com' };
    expect(evaluateDns('a.com', [ans('c', ['104.21.3.4'])], t).ok).toBe(true);
    expect(evaluateDns('a.com', [ans('c', [], [], { cname: ['abc.cfargotunnel.com'] })], t).ok).toBe(true);
    expect(evaluateDns('a.com', [ans('c', ['203.0.113.10'])], t).ok).toBe(false);
  });
});

describe('isCloudflareProxyIp / lookupNameFor / apexOf', () => {
  it('ranges', () => {
    expect(isCloudflareProxyIp('104.16.0.1')).toBe(true);
    expect(isCloudflareProxyIp('203.0.113.10')).toBe(false);
    expect(isCloudflareProxyIp('2606:4700::1')).toBe(true);
  });
  it('wildcards look up a probe label', () => {
    expect(lookupNameFor('*.Acme.com')).toBe('swarmy-dns-check.acme.com');
    expect(lookupNameFor('shop.acme.com.')).toBe('shop.acme.com');
  });
  it('apex heuristics', () => {
    expect(apexOf('shop.acme.com')).toBe('acme.com');
    expect(apexOf('shop.acme.co.uk')).toBe('acme.co.uk');
    expect(apexOf('*.acme.com')).toBe('acme.com');
  });
});

describe('dnsGuidance (golden)', () => {
  it('A + AAAA records for a subdomain, CNAME alternative', () => {
    expect(dnsGuidance({ host: 'shop.acme.com', expected: EDGE, cnameTarget: 'swarmy.203-0-113-10.sslip.io' })).toEqual({
      mode: 'records',
      summary: 'At your DNS provider, point shop.acme.com at swarmy’s edge. Add one record per address — visitors are spread across the edges. Remove any other A/AAAA records for this name.',
      records: [
        { type: 'A', name: 'shop.acme.com', label: 'shop', value: '203.0.113.10' },
        { type: 'AAAA', name: 'shop.acme.com', label: 'shop', value: '2001:db8::10' },
      ],
      alternatives: [
        {
          type: 'CNAME',
          name: 'shop.acme.com',
          label: 'shop',
          value: 'swarmy.203-0-113-10.sslip.io',
          note: 'Follows the edge if its IPs change. Not allowed at the apex.',
        },
      ],
    });
  });
  it('apex: no CNAME alternative, label @', () => {
    const g = dnsGuidance({ host: 'acme.com', expected: { ips: ['203.0.113.10'] }, cnameTarget: 'x.example.net' });
    expect(g.records).toEqual([{ type: 'A', name: 'acme.com', label: '@', value: '203.0.113.10' }]);
    expect(g.alternatives).toEqual([]);
  });
  it('zone mode: NS delegation with glue', () => {
    const g = dnsGuidance({
      host: 'shop.acme.com',
      expected: EDGE,
      zone: { zone: 'acme.com', delegated: false, nameservers: [{ fqdn: 'ns1.acme.com', ip: '203.0.113.10' }] },
    });
    expect(g.mode).toBe('zone');
    expect(g.records).toEqual([{ type: 'NS', name: 'acme.com', label: '@', value: 'ns1.acme.com', note: 'Glue: ns1.acme.com → 203.0.113.10' }]);
  });
  it('tunnel + private', () => {
    expect(dnsGuidance({ host: 'a.acme.com', expected: { ips: [], tunnelCname: 't.cfargotunnel.com' } }).records[0]).toEqual({
      type: 'CNAME',
      name: 'a.acme.com',
      label: 'a',
      value: 't.cfargotunnel.com',
      note: 'Proxied (orange cloud).',
    });
    expect(dnsGuidance({ host: 'nas.lan', expected: EDGE, private: true }).mode).toBe('private');
  });
});

describe('certificates', () => {
  it('certCoversHost: exact + one-level wildcard', () => {
    expect(certCoversHost('DNS:acme.com, DNS:www.acme.com', 'www.acme.com')).toBe(true);
    expect(certCoversHost('DNS:*.acme.com', 'shop.acme.com')).toBe(true);
    expect(certCoversHost('DNS:*.acme.com', 'a.b.acme.com')).toBe(false);
    expect(certCoversHost('DNS:*.acme.com', 'acme.com')).toBe(false);
    expect(certCoversHost(null, 'acme.com')).toBe(false);
  });
  it('certFromProbes: trusted cert on one of two edges', () => {
    const c = certFromProbes('acme.com', [
      { ip: '203.0.113.10', authorized: true, issuerOrg: "Let's Encrypt", validTo: 'Dec 22 12:00:00 2026 GMT', subjectAltName: 'DNS:acme.com' },
      { ip: '203.0.113.11', error: 'tlsv1 alert internal error' },
    ]);
    expect(c).toEqual({
      ok: true,
      issuer: "Let's Encrypt",
      notAfter: Date.parse('Dec 22 12:00:00 2026 GMT'),
      error: null,
      edges: [
        { ip: '203.0.113.10', ok: true },
        { ip: '203.0.113.11', ok: false, error: 'the edge has no certificate for this name yet' },
      ],
    });
  });
  it('certFromProbes: self-signed fallback and wrong name', () => {
    expect(
      certFromProbes('acme.com', [
        { ip: 'x', authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', subjectAltName: 'DNS:acme.com' },
      ]).error,
    ).toBe('the edge is serving a temporary/self-signed certificate (a public one has not been issued yet)');
    expect(certFromProbes('acme.com', [{ ip: 'x', authorized: true, subjectAltName: 'DNS:other.com' }]).error).toBe(
      'the edge is serving a certificate for a different name',
    );
  });
});

describe('gate + state machine', () => {
  const dnsOk = { ok: true, reason: null, warnings: [], a: ['203.0.113.10'], aaaa: [], cname: [], matched: ['203.0.113.10'] };
  const dnsBad = { ...dnsOk, ok: false, reason: 'a.com points at 198.51.100.7 — expected 203.0.113.10.', matched: [] };
  const cert = (notAfter: number, ok = true) => ({ ok, issuer: "Let's Encrypt", notAfter: ok ? notAfter : null, error: ok ? null : 'x', edges: [] });

  it('new auto-TLS host is gated; off/private/tunnel/grandfathered are not', () => {
    expect(newDomainRecord(posture('a.com'), NOW).gated).toBe(true);
    expect(newDomainRecord(posture('a.com', { tls: 'off' }), NOW).gated).toBe(false);
    expect(newDomainRecord(posture('a.com', { tunnel: true }), NOW).gated).toBe(false);
    expect(newDomainRecord(posture('a.com'), NOW, true).gated).toBe(false);
  });

  it('isHostGated: only registered, unverified records gate', () => {
    const rec = newDomainRecord(posture('a.com'), NOW);
    expect(isHostGated({ hosts: { 'a.com': rec } }, 'A.com')).toBe(true);
    expect(isHostGated({ hosts: { 'a.com': { ...rec, verifiedAt: NOW } } }, 'a.com')).toBe(false);
    expect(isHostGated({ hosts: {} }, 'b.com')).toBe(false);
    expect(isHostGated(undefined, 'b.com')).toBe(false);
  });

  it('walks waiting_dns → verified → issuing → active', () => {
    const p = posture('a.com');
    let rec: DomainCheckRecord = newDomainRecord(p, NOW);
    expect(domainState(rec, p, NOW).state).toBe('waiting_dns');
    rec = applyCheck(rec, { dns: dnsBad }, NOW);
    expect(domainState(rec, p, NOW)).toEqual({ state: 'waiting_dns', reason: dnsBad.reason!, warnings: [] });
    expect(rec.nextCheckAt).toBe(NOW + 30_000);
    const before = rec;
    rec = applyCheck(rec, { dns: dnsOk }, NOW + 60_000);
    expect(becameRenderable(before, rec)).toBe(true);
    expect(domainState(rec, p, NOW + 60_000).state).toBe('verified');
    rec = applyCheck(rec, { dns: dnsOk, cert: cert(0, false) }, NOW + 120_000);
    expect(domainState(rec, p, NOW + 120_000).state).toBe('issuing');
    expect(rec.nextCheckAt).toBe(NOW + 180_000);
    rec = applyCheck(rec, { dns: dnsOk, cert: cert(NOW + 90 * 86_400_000) }, NOW + 180_000);
    expect(domainState(rec, p, NOW + 180_000)).toEqual({
      state: 'active',
      reason: "Secured by Let's Encrypt until 2026-12-23.",
      warnings: [],
    });
  });

  it('issuing turns into error after the grace window', () => {
    const p = posture('a.com');
    const rec = applyCheck({ ...newDomainRecord(p, NOW), verifiedAt: NOW }, { dns: dnsOk, cert: cert(0, false) }, NOW + ISSUE_GRACE_MS + 60_000);
    expect(domainState(rec, p, NOW + ISSUE_GRACE_MS + 60_000).state).toBe('error');
  });

  it('verification is sticky; DNS moving away is error, not re-gated', () => {
    const p = posture('a.com');
    let rec = applyCheck(newDomainRecord(p, NOW), { dns: dnsOk }, NOW);
    rec = applyCheck(rec, { dns: dnsBad }, NOW + 1000);
    expect(rec.verifiedAt).toBe(NOW);
    expect(isHostGated({ hosts: { 'a.com': rec } }, 'a.com')).toBe(false);
    expect(domainState(rec, p, NOW + 1000).state).toBe('error');
  });

  it('expired and expiring certificates', () => {
    const p = posture('a.com');
    const base = applyCheck(newDomainRecord(p, NOW), { dns: dnsOk }, NOW);
    expect(domainState(applyCheck(base, { cert: cert(NOW - 1) }, NOW), p, NOW).state).toBe('error');
    const soon = domainState(applyCheck(base, { cert: cert(NOW + 86_400_000) }, NOW), p, NOW);
    expect(soon.state).toBe('active');
    expect(soon.warnings).toEqual(['Certificate expires 2026-09-25 and has not renewed yet.']);
  });

  it('private hosts are active with a local-CA note; tls off is active once DNS points', () => {
    expect(domainState(undefined, posture('nas.lan', { private: true }), NOW).state).toBe('active');
    const p = posture('a.com', { tls: 'off' });
    expect(domainState(applyCheck(newDomainRecord(p, NOW), { dns: dnsOk }, NOW), p, NOW).state).toBe('active');
  });
});

describe('planDomainChecks', () => {
  it('discovered hosts get ungated records and are checked; private skipped', () => {
    const plan = planDomainChecks({ hosts: [posture('b.com'), posture('a.com'), posture('nas.lan', { private: true })], checks: undefined, now: NOW });
    expect(plan.create.map((r) => [r.host, r.gated])).toEqual([
      ['a.com', false],
      ['b.com', false],
    ]);
    expect(plan.check).toEqual(['a.com', 'b.com']);
  });

  it('due hosts checked, not-due skipped, gone hosts pruned', () => {
    const plan = planDomainChecks({
      hosts: [posture('a.com'), posture('new.com')],
      checks: {
        hosts: {
          'a.com': { host: 'a.com', addedAt: 0, gated: false, nextCheckAt: NOW + 5000 },
          'gone.com': { host: 'gone.com', addedAt: 0, gated: false },
          'landing.com': { host: 'landing.com', addedAt: NOW - 5000, gated: true },
        },
      },
      now: NOW,
    });
    expect(plan.create).toEqual([{ host: 'new.com', addedAt: NOW, gated: false }]);
    expect(plan.check).toEqual(['new.com']);
    expect(plan.prune).toEqual(['gone.com']);
  });

  it('caps the tick and checks the most overdue first', () => {
    const hosts = ['a.com', 'b.com', 'c.com'].map((h) => posture(h));
    const plan = planDomainChecks({
      hosts,
      checks: {
        hosts: {
          'a.com': { host: 'a.com', addedAt: 0, gated: false, nextCheckAt: NOW - 10 },
          'b.com': { host: 'b.com', addedAt: 0, gated: false, nextCheckAt: NOW - 1000 },
          'c.com': { host: 'c.com', addedAt: 0, gated: false, nextCheckAt: NOW - 100 },
        },
      },
      now: NOW,
      max: 2,
    });
    expect(plan.check).toEqual(['b.com', 'c.com']);
  });
});

describe('certAlertFor', () => {
  const p = posture('a.com');
  const base = { host: 'a.com', addedAt: 0, gated: false, verifiedAt: NOW - ISSUE_GRACE_MS * 3, lastCheckedAt: NOW, dns: { ok: true, reason: null, warnings: [], a: [], aaaa: [], cname: [], matched: [] } };
  const withCert = (notAfter: number | null, ok = true, error: string | null = null) => ({
    ...base,
    cert: { ok, issuer: 'R3', notAfter, error, edges: [] },
  });
  it('resolves when comfortably valid, warns under 14d, critical under 3d / expired', () => {
    expect(certAlertFor(withCert(NOW + 60 * 86_400_000), p, NOW)?.status).toBe('resolved');
    expect(certAlertFor(withCert(NOW + 10 * 86_400_000), p, NOW)).toEqual({
      status: 'firing',
      severity: 'warning',
      message: 'Certificate for a.com expires 2026-10-04 (10 days) and has not renewed yet.',
    });
    expect(certAlertFor(withCert(NOW + 86_400_000), p, NOW)?.severity).toBe('critical');
    expect(certAlertFor(withCert(NOW - 1), p, NOW)?.severity).toBe('critical');
  });
  it('critical when issuance/renewal is failing past the grace window', () => {
    expect(certAlertFor(withCert(null, false, 'the edge has no certificate for this name yet'), p, NOW)).toEqual({
      status: 'firing',
      severity: 'critical',
      message: 'Certificate for a.com is failing: the edge has no certificate for this name yet',
    });
  });
  it('silent while not verified, issuing within grace, or tls off', () => {
    expect(certAlertFor({ ...withCert(null, false), verifiedAt: undefined }, p, NOW)).toBeNull();
    expect(certAlertFor({ ...withCert(null, false), verifiedAt: NOW - 1000 }, p, NOW)).toBeNull();
    expect(certAlertFor(withCert(NOW + 86_400_000), posture('a.com', { tls: 'off' }), NOW)).toBeNull();
  });
});
