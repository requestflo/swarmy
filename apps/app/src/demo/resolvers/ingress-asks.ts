import type { AskDecision, CertIssuance } from '@/components/ingress/edge/edge-certs-model';
import type { DemoStore, DomainResolvers } from '../types';
import { edgesOf } from './ingress';
import { demoCertFacts } from './ingress-certs';

/**
 * Edge settings' certificate reads in the demo (board 31): the issuance
 * count folds the same certificates the Domain detail shows
 * (`demoCertFacts`, one per live address, counted once across the edges),
 * and the ask log is what the edges would have asked `/ingress/ask` lately —
 * routed addresses allowed, a new apex refused until its DNS moved, a typo
 * and a scanner.
 */

const DAY = 86_400_000;
const MIN = 60_000;

function demoHosts(s: DemoStore): Array<{ host: string; stack: string }> {
  const st = s.extra.ingress as { domains?: Array<{ host: string; stack: string }> } | undefined;
  return (st?.domains ?? []).map((d) => ({ host: d.host, stack: d.stack }));
}

function demoIssuance(s: DemoStore, now = Date.now()): CertIssuance {
  const certs = new Map<string, number>();
  for (const { host } of demoHosts(s)) {
    const c = demoCertFacts(s, host).cert;
    if (c) certs.set(`${c.serial}:${host}`, Date.parse(c.notBefore));
  }
  const today = Math.floor(now / DAY) * DAY;
  const days = Array.from({ length: 30 }, (_, i) => ({ day: new Date(today - (29 - i) * DAY).toISOString().slice(0, 10), issued: 0 }));
  let inWindow = 0;
  for (const at of certs.values()) {
    const d = days.find((x) => x.day === new Date(at).toISOString().slice(0, 10));
    if (d) {
      d.issued += 1;
      inWindow += 1;
    }
  }
  const latest = Math.max(...certs.values());
  const edges = edgesOf(s).length;
  return {
    held: certs.size,
    local: 0,
    days,
    inWindow,
    latestAt: certs.size ? new Date(latest).toISOString() : null,
    reported: edges,
    edges,
    source: edges === 0 ? 'no_edges' : 'edges',
  };
}

function demoAskLog(s: DemoStore, now = Date.now()): AskDecision[] {
  const appOf = new Map(demoHosts(s).map((h) => [h.host, h.stack]));
  const ago = (m: number): string => new Date(now - m * MIN).toISOString();
  const allowed = (host: string, m: number): AskDecision[] =>
    appOf.has(host) ? [{ host, allowed: true, status: 200, why: 'routed', app: appOf.get(host) ?? null, at: ago(m), count: 1 }] : [];
  return [
    ...allowed('api.northwind.dev', 38),
    // A new apex: refused while its DNS still pointed elsewhere, then issued once it moved.
    ...allowed('northwind.shop', 20 * 60),
    ...(appOf.has('northwind.shop')
      ? [{ host: 'northwind.shop', allowed: false, status: 403 as const, why: 'dns-pending' as const, app: appOf.get('northwind.shop') ?? null, at: ago(21 * 60), count: 3 }]
      : []),
    { host: 'nortwind.dev', allowed: false, status: 403, why: 'unknown', app: null, at: ago(26 * 60), count: 2 },
    { host: 'admin.159-69-12-40.nip.io', allowed: false, status: 403, why: 'unknown', app: null, at: ago(2 * 24 * 60), count: 41 },
  ];
}

export const ingressAsks: DomainResolvers = {
  handlers: {
    'ingress.certIssuance': (_i, s): CertIssuance => demoIssuance(s),
    'ingress.askLog': (_i, s): AskDecision[] => demoAskLog(s),
  },
};
