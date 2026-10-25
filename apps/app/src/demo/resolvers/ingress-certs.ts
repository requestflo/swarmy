import type { CertFacts } from '@/components/app-domains/cert-facts-model';
import type { DemoStore, DomainResolvers } from '../types';
import { demoRouteFor, edgesOf } from './ingress';

/**
 * The demo's certificate facts and Renew now for the Domain detail (board
 * 30): what each edge's Caddy storage would hold for a routed host — the
 * same 90-day Let's Encrypt certificate `ingress.domainStatus` probes, on
 * every edge. A host still issuing (or with HTTPS off) holds none yet. Renew
 * now follows the real rules: refused with the shared store (the demo's
 * edge-per-node seed), once an hour per host otherwise.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LE = 'acme-v02.api.letsencrypt.org-directory';
const ISSUER = "Let's Encrypt R11";

/** Demo-only: when each host was renewed on request (epoch ms). */
const renewedAt = (s: DemoStore): Record<string, number> => ((s.extra.ingressCerts ??= {}) as Record<string, number>);

/** The seeded certificate's dates: issued 10 days ago (or when renewed), 90-day lifetime. */
export function demoCertDates(now = Date.now(), renewed?: number): { notBefore: string; notAfter: string } {
  const issued = renewed !== undefined ? renewed - HOUR : Math.floor((now - 10 * DAY) / DAY) * DAY + 3 * HOUR;
  return { notBefore: new Date(issued).toISOString(), notAfter: new Date(issued + 90 * DAY).toISOString() };
}

/** Mirror of `@swarmy/ingress` `renewalWindow`: Caddy renews with a third of the lifetime left. */
function demoRenewal(notBefore: string, notAfter: string, now = Date.now()): NonNullable<CertFacts['renewal']> {
  const from = Date.parse(notBefore);
  const to = Date.parse(notAfter);
  const renewAt = to - (to - from) / 3;
  return {
    renewAt: new Date(renewAt).toISOString(),
    lifetimeDays: Math.round((to - from) / DAY),
    state: now >= to ? 'expired' : now >= renewAt ? 'due' : 'ahead',
    daysUntil: Math.max(0, Math.ceil((renewAt - now) / DAY)),
  };
}

/** Mirror of `renewEligibility` for the demo's states. */
function demoRenew(shared: boolean, renewed: number | undefined, now = Date.now()): CertFacts['renew'] {
  if (shared) {
    return { available: false, why: 'shared_store', reason: 'Front doors share one certificate store, and each would load the old certificate back from it, so it cannot be renewed early here. It still renews itself.' };
  }
  if (renewed !== undefined && now - renewed < HOUR) {
    return {
      available: false,
      why: 'rate',
      reason: "It was renewed early less than an hour ago. Renewing early spends one of your 5-a-week Let's Encrypt certificates for this name.",
      retryAt: new Date(renewed + HOUR).toISOString(),
    };
  }
  return { available: true };
}

export function demoCertFacts(s: DemoStore, host: string): CertFacts {
  const route = demoRouteFor(s, host);
  const edges = edgesOf(s);
  const checkedAt = new Date(Date.now() - 20_000).toISOString();
  if (!route || !route.live) {
    const state = 'missing' as const;
    const renew = { available: false as const, why: 'no_cert' as const, reason: 'No front door holds a certificate for it yet.' };
    return { host, source: 'edges', reason: null, cert: null, edges: edges.map((e) => ({ nodeId: e.name, name: e.name, state, reason: null })), renewal: null, renewals: [], renew, checkedAt };
  }
  const renewed = renewedAt(s)[host];
  const { notBefore, notAfter } = demoCertDates(Date.now(), renewed);
  const seeded = demoCertDates();
  const names = host === route.host && route.www ? [host, `www.${host}`] : [host];
  const renewals: CertFacts['renewals'] = [
    // The one before the seeded certificate was a 90-day one too, renewed with a third of its life left.
    { at: seeded.notBefore, issuer: ISSUER, replaced: new Date(Date.parse(seeded.notBefore) - 60 * DAY).toISOString(), by: 'automatic' },
  ];
  if (renewed !== undefined) renewals.unshift({ at: notBefore, issuer: ISSUER, replaced: seeded.notBefore, by: 'request' });
  return {
    host,
    source: 'edges',
    reason: null,
    cert: { issuer: ISSUER, issuerKey: LE, notBefore, notAfter, names, wildcard: null, serial: renewed ? '05B2C3D4E5F60718293A4B5C6D7E8F9A0B1C' : '04A1B2C3D4E5F60718293A4B5C6D7E8F9A0B' },
    edges: edges.map((e) => ({ nodeId: e.name, name: e.name, state: 'holds' as const, reason: null })),
    renewal: demoRenewal(notBefore, notAfter),
    renewals,
    renew: demoRenew(route.shared, renewed),
    checkedAt,
  };
}

export const ingressCerts: DomainResolvers = {
  handlers: {
    'ingress.certFacts': (i, s): CertFacts => demoCertFacts(s, (i as { host: string }).host),
    'ingress.renewCert': (i, s) => {
      const host = (i as { host: string }).host;
      const before = demoCertFacts(s, host);
      if (!before.renew.available) throw new Error(before.renew.reason);
      renewedAt(s)[host] = Date.now();
      const facts = demoCertFacts(s, host);
      return {
        host,
        outcome: 'renewed' as const,
        message: `${host} has a new certificate.`,
        edges: facts.edges.map((e) => ({ nodeId: e.nodeId, name: e.name, outcome: 'renewed' as const, message: `${host} has a new certificate` })),
        facts,
      };
    },
  },
};
