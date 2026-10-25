import type { CaaFacts } from '@/components/app-domains/caa-words';
import type { DomainResolvers } from '../types';

/**
 * The demo's CAA answer for the Domain detail (board 30): northwind.dev
 * publishes `0 issue "letsencrypt.org"` (and an iodef contact) at the zone
 * apex, so every address under it may be issued by Let's Encrypt; any other
 * name has no CAA records at all.
 */

const CA = { name: "Let's Encrypt", caa: 'letsencrypt.org' };

function climb(host: string): string[] {
  const labels = host.toLowerCase().replace(/^\*\./, '').split('.').filter(Boolean);
  return labels.map((_, i) => labels.slice(i).join('.'));
}

export function demoCaa(host: string): CaaFacts {
  const names = climb(host);
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const apex = names.indexOf('northwind.dev');
  if (apex >= 0) {
    return {
      host,
      ca: CA,
      state: 'allowed',
      at: 'northwind.dev',
      allowed: ['letsencrypt.org'],
      records: [
        { critical: 0, tag: 'issue', value: 'letsencrypt.org' },
        { critical: 0, tag: 'iodef', value: 'mailto:security@northwind.dev' },
      ],
      caveats: [],
      say: "CAA at northwind.dev lets Let's Encrypt issue (letsencrypt.org allowed).",
      asked: names.slice(0, apex + 1),
      checkedAt,
    };
  }
  return {
    host,
    ca: CA,
    state: 'open',
    at: null,
    allowed: [],
    records: [],
    caveats: [],
    say: "No CAA records for it or its parents, so any certificate authority may issue, Let's Encrypt included.",
    asked: names,
    checkedAt,
  };
}

export const ingressCaa: DomainResolvers = {
  handlers: {
    'ingress.caa': (i): CaaFacts => demoCaa((i as { host: string }).host),
  },
};
