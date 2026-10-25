import type { CertFacts } from '@/components/app-domains/cert-facts-model';
import type { DemoStore, DomainResolvers } from '../types';
import { demoRouteFor, edgesOf } from './ingress';

/**
 * The demo's certificate facts for the Domain detail (board 30): what each
 * edge's Caddy storage would hold for a routed host — the same 90-day Let's
 * Encrypt certificate `ingress.domainStatus` probes (80 days left), on every
 * edge. A host still issuing (or with HTTPS off) holds none yet.
 */

const DAY = 86_400_000;
const LE = 'acme-v02.api.letsencrypt.org-directory';

/** The seeded certificate's dates: issued 10 days ago, 90-day lifetime. */
export function demoCertDates(now = Date.now()): { notBefore: string; notAfter: string } {
  const issued = Math.floor((now - 10 * DAY) / DAY) * DAY + 3 * 3_600_000;
  return { notBefore: new Date(issued).toISOString(), notAfter: new Date(issued + 90 * DAY).toISOString() };
}

export function demoCertFacts(s: DemoStore, host: string): CertFacts {
  const route = demoRouteFor(s, host);
  const edges = edgesOf(s);
  const checkedAt = new Date(Date.now() - 20_000).toISOString();
  if (!route || !route.live) {
    return {
      host,
      source: 'edges',
      reason: null,
      cert: null,
      edges: edges.map((e) => ({ nodeId: e.name, name: e.name, state: 'missing' as const, reason: null })),
      checkedAt,
    };
  }
  const { notBefore, notAfter } = demoCertDates();
  const names = host === route.host && route.www ? [host, `www.${host}`] : [host];
  return {
    host,
    source: 'edges',
    reason: null,
    cert: { issuer: "Let's Encrypt R11", issuerKey: LE, notBefore, notAfter, names, wildcard: null, serial: '04A1B2C3D4E5F60718293A4B5C6D7E8F9A0B' },
    edges: edges.map((e) => ({ nodeId: e.name, name: e.name, state: 'holds' as const, reason: null })),
    checkedAt,
  };
}

export const ingressCerts: DomainResolvers = {
  handlers: {
    'ingress.certFacts': (i, s): CertFacts => demoCertFacts(s, (i as { host: string }).host),
  },
};
