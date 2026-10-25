import { describe, expect, it } from 'bun:test';
import { RENEW_MIN_GAP_MS, renewEligibility, renewRateLimit, withoutHost, type RenewAsk } from './cert-renew';
import type { IngressConfig } from './types';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ask = (over: Partial<RenewAsk> = {}): RenewAsk => ({
  tls: 'auto',
  store: 'local',
  cert: { issuerKey: 'acme-v02.api.letsencrypt.org-directory', wildcard: null },
  agentsReady: true,
  caaAllows: true,
  attempts: [],
  inFlight: false,
  now: NOW,
  ...over,
});

describe('renewRateLimit (so a renew can never burn the ACME limits)', () => {
  it('once an hour per host', () => {
    expect(renewRateLimit([NOW - 30 * 60_000], NOW)).toEqual({ ok: false, retryAt: NOW + 30 * 60_000, reason: 'It was renewed early less than an hour ago.' });
    expect(renewRateLimit([NOW - RENEW_MIN_GAP_MS], NOW)).toEqual({ ok: true });
  });

  it('three a week, then again when the oldest leaves the week', () => {
    const r = renewRateLimit([NOW - 6 * D, NOW - 3 * D, NOW - 2 * H], NOW);
    expect(r).toEqual({ ok: false, retryAt: NOW + D, reason: 'It was renewed early 3 times this week already.' });
    expect(renewRateLimit([NOW - 8 * D, NOW - 3 * D, NOW - 2 * H], NOW)).toEqual({ ok: true });
  });
});

describe('renewEligibility', () => {
  it('offered for an ACME certificate on a local store', () => {
    expect(renewEligibility(ask())).toEqual({ available: true });
  });

  it('says why not, in the order a person would fix it', () => {
    const why = (over: Partial<RenewAsk>) => {
      const e = renewEligibility(ask(over));
      return e.available ? 'available' : e.why;
    };
    expect(why({ tls: 'off' })).toBe('tls_off');
    expect(why({ tls: 'custom' })).toBe('own_cert');
    expect(why({ store: 'shared', cert: null })).toBe('shared_store');
    expect(why({ cert: null })).toBe('no_cert');
    expect(why({ cert: { issuerKey: 'acme-v02', wildcard: '*.northwind.dev' } })).toBe('wildcard');
    expect(why({ cert: { issuerKey: 'local', wildcard: null } })).toBe('local_ca');
    expect(why({ agentsReady: false })).toBe('old_agent');
    expect(why({ caaAllows: false })).toBe('caa');
    expect(why({ caaAllows: null })).toBe('available');
    expect(why({ inFlight: true })).toBe('busy');
    expect(why({ attempts: [NOW - 60_000] })).toBe('rate');
  });

  it('a rate block carries when it opens again and the Let’s Encrypt reason', () => {
    const e = renewEligibility(ask({ attempts: [NOW - 60_000] }));
    expect(e).toEqual({
      available: false,
      why: 'rate',
      reason: "It was renewed early less than an hour ago. Renewing early spends one of your 5-a-week Let's Encrypt certificates for this name.",
      retryAt: '2026-10-24T12:59:00.000Z',
    });
  });
});

describe('withoutHost', () => {
  it('leaves out the host’s routes, redirects and vhosts, and nothing else', () => {
    const cfg = {
      driver: 'caddy', enabled: true, orgId: 'o', targetNodes: [],
      domains: [{ domain: 'shop.dev', service: 'web', port: 80 }, { domain: 'Shop.dev', pathPrefix: '/api', service: 'api', port: 81 }, { domain: 'api.dev', service: 'api', port: 81 }],
      controllerVhosts: [{ domain: 'status.dev', upstream: 'c:1', targetPath: '/s', kind: 'status-page' }],
      hostRedirects: [{ from: 'www.shop.dev', to: 'shop.dev' }, { from: 'shop.dev', to: 'www.shop.dev' }],
    } as unknown as IngressConfig;
    const out = withoutHost(cfg, 'shop.dev');
    expect(out.domains.map((d) => d.domain)).toEqual(['api.dev']);
    expect(out.hostRedirects?.map((r) => r.from)).toEqual(['www.shop.dev']);
    expect(out.controllerVhosts.length).toBe(1);
    expect(cfg.domains.length).toBe(3);
  });
});
