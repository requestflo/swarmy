/**
 * Pure: Edge settings' certificate words (board 31) — the issuance count
 * (`ingress.certIssuance`) and the on-demand ask log (`ingress.askLog`).
 * Unit-tested in edge-certs-model.test.ts.
 */
import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';

export type CertIssuance = inferOutput<TRPCOptionsProxy<AppRouter>['ingress']['certIssuance']>;
export type AskDecision = inferOutput<TRPCOptionsProxy<AppRouter>['ingress']['askLog']>[number];

const DAY = 86_400_000;

/** "today", "yesterday", "3 days ago", "12 Sep". */
export function dayWords(iso: string, now = Date.now()): string {
  const days = Math.floor(now / DAY) - Math.floor(Date.parse(iso) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The right-hand count on the Certificates line: "6 issued". */
export const issuedCount = (i: CertIssuance): string => `${i.held} issued`;

/** The sentence: how many in the last 30 days, and the newest. */
export function issuanceWords(i: CertIssuance, now = Date.now()): string {
  if (i.source === 'no_edges') return 'No front door is running, so no edge holds a certificate.';
  if (i.source === 'not_reported') return 'The edges can’t say what they hold yet (their agents predate the certificate read).';
  if (i.held === 0) return 'The edges hold no certificate yet: one is issued at an address’s first visit.';
  const recent = i.inWindow === 0 ? `none in the last ${i.days.length} days` : `${i.inWindow} in the last ${i.days.length} days`;
  const newest = i.latestAt ? `, the newest ${dayWords(i.latestAt, now)}` : '';
  const partial = i.reported < i.edges ? ` (${i.reported} of ${i.edges} edges answered)` : '';
  return `${i.held} held across the edges: ${recent}${newest}${partial}.`;
}

/** What Caddy did with each answer, in plain words. */
export function askThen(a: Pick<AskDecision, 'why' | 'app'>): string {
  switch (a.why) {
    case 'routed':
      return a.app ? `routed to ${a.app}, so the edge asks Let’s Encrypt` : 'one of your addresses, so the edge asks Let’s Encrypt';
    case 'dns-pending':
      return 'its DNS doesn’t point at your edges yet, so no certificate';
    case 'unknown':
      return 'not one of your addresses, so no certificate';
    case 'invalid':
      return 'not a valid name';
  }
}

/** "10:31", "yesterday 10:31", "24 Oct" — and "×14, last 10:31" for a repeated answer. */
export function askWhen(a: Pick<AskDecision, 'at' | 'count'>, now = Date.now()): string {
  const day = dayWords(a.at, now);
  const time = new Date(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const t = day === 'today' ? time : day === 'yesterday' ? `yesterday ${time}` : day;
  return a.count > 1 ? `×${a.count}, last ${t}` : t;
}

/** The ask log's title: what the latest refusal says, or that everything got through. */
export function askTitle(log: readonly AskDecision[]): string {
  if (log.length === 0) return 'No edge has asked yet';
  const refused = log.filter((a) => !a.allowed).length;
  if (refused === 0) return `The last ${log.length === 1 ? 'ask was' : `${log.length} asks were all`} allowed`;
  return `${refused} of the last ${log.length} asks refused`;
}
