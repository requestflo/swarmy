import type { ResolverState } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { DnsGate, DomainStatus, ResolverView } from '@/components/ingress/domain-state';

/** The word and tone for one resolver's state (map dot, list, legend). */
export const RESOLVER_WORD: Record<ResolverState, { word: string; tone: Tone }> = {
  agrees: { word: 'sees your edges', tone: 'ok' },
  cached: { word: 'still cached', tone: 'warn' },
  no_answer: { word: 'no answer', tone: 'idle' },
  error: { word: 'answered with an error', tone: 'idle' },
};

/** What one resolver said, in a few words. */
export function resolverAnswer(r: ResolverView): string {
  if (r.error) return r.state === 'error' ? `error (${r.error})` : 'no answer';
  if (r.ips.length) return r.ips.join(', ');
  if (r.cname.length) return `CNAME ${r.cname.join(', ')} (no address)`;
  return r.nxdomain ? 'no such name yet' : 'no address record';
}

/** The public resolvers (the map) and the ones inside the cluster. */
export function splitResolvers(resolvers: readonly ResolverView[]): { world: ResolverView[]; local: ResolverView[] } {
  return { world: resolvers.filter((r) => r.tier === 'public'), local: resolvers.filter((r) => r.tier === 'local') };
}

/**
 * The gate on the last check. Records written before the gate was kept carry
 * none: derive the counts from the resolvers (every answering one had to agree).
 */
export function gateOf(d: Pick<DomainStatus, 'dns'>): DnsGate | null {
  if (!d.dns) return null;
  if (d.dns.gate) return d.dns.gate;
  const answered = d.dns.resolvers.filter((r) => !r.error);
  if (answered.length === 0) return null;
  const agreeing = answered.filter((r) => r.state === 'agrees').length;
  return { basis: 'public', agreeing, answering: answered.length, needed: answered.length, anchors: [], anchorsAgree: true, pass: agreeing === answered.length };
}

/** "1.1.1.1 and 8.8.8.8" · "1.1.1.1" · "" */
export function anchorWords(g: DnsGate): string {
  return g.anchors.join(' and ');
}

/** The rail's sub-lines for steps 1 and 2. */
export function railDnsLines(g: DnsGate | null, manual: boolean): [string, string] {
  if (manual) return ['skipped by an admin', 'without a DNS check'];
  if (!g || g.basis === 'none') return ['asking resolvers…', 'most resolvers must agree'];
  if (g.basis === 'local') {
    return [`${g.agreeing} of ${g.answering} of swarmy’s resolvers`, g.pass ? 'swarmy’s own resolvers agree' : 'swarmy’s own resolvers must agree'];
  }
  const incl = g.anchors.length ? `, including ${anchorWords(g)}` : '';
  return [`${g.agreeing} of ${g.answering} resolvers`, g.pass ? `${g.agreeing} of ${g.answering} agree${incl}` : `needs ${g.needed} of ${g.answering}${incl}`];
}

/** The exact rule, for the Tech line. */
export function gateRuleTech(g: DnsGate | null): string {
  const anchors = g?.anchors.length ? ` && {${g.anchors.join(', ')}} ⊆ agreeing` : '';
  const now = g && g.basis === 'public' ? ` · now ${g.agreeing}/${g.answering}, needs ${g.needed}${g.anchors.length ? `, anchors ${g.anchorsAgree ? 'agree' : 'behind'}` : ''}` : '';
  return `gate · agreeing ≥ ⌈3 × answering ÷ 4⌉${anchors} · timeouts and errors leave the count · no public answer → system + swarmy-dns must all agree${now}`;
}
