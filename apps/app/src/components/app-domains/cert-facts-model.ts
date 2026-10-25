/**
 * Pure: the certificate facts the edges hold (`ingress.certFacts`), said for
 * the Domain detail's Certificate card (board 30): issued and expiry, what
 * it covers, which servers hold it.
 */
import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';

export type CertFacts = inferOutput<TRPCOptionsProxy<AppRouter>['ingress']['certFacts']>;
export type CertFact = NonNullable<CertFacts['cert']>;

const day = (iso: string, year: boolean): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });

/** "issued 23 Sep · expires 22 Dec 2026" (the issue year only when it differs). */
export function issuedLine(notBefore: string, notAfter: string): string {
  const sameYear = new Date(notBefore).getUTCFullYear() === new Date(notAfter).getUTCFullYear();
  return `issued ${day(notBefore, !sameYear)} · expires ${day(notAfter, true)}`;
}

/** The names it covers for this address: the wildcard when one covers it, else every name. */
export function coversLine(cert: Pick<CertFact, 'names' | 'wildcard'>, host: string): { names: string; note: string | null } {
  if (cert.wildcard) {
    return { names: cert.wildcard, note: `a wildcard: every address one level under ${cert.wildcard.slice(2)}, ${host} included` };
  }
  const names = [host, ...cert.names.filter((n) => n !== host)];
  return { names: names.join(' · '), note: null };
}

export interface ServedByEdge {
  key: string;
  name: string;
  ok: boolean;
  /** Said after the name when it isn't simply serving it. */
  note: string | null;
}

const HOLD_NOTE: Record<CertFacts['edges'][number]['state'], string | null> = {
  holds: null,
  other: 'an older copy',
  missing: 'not yet',
  not_reported: 'not reported',
  error: 'could not read',
};

/**
 * Who serves it: the edges' own storage when any reported, else the
 * controller's TLS probe of each edge's public address.
 */
export function servedBy(
  facts: CertFacts | null | undefined,
  probed: ReadonlyArray<{ ip: string; ok: boolean }>,
  nameOf: (ip: string) => string,
): ServedByEdge[] {
  if (facts?.source === 'edges') {
    return facts.edges.map((e) => ({ key: e.nodeId, name: e.name, ok: e.state === 'holds', note: HOLD_NOTE[e.state] }));
  }
  return probed.map((e) => ({ key: e.ip, name: nameOf(e.ip), ok: e.ok, note: e.ok ? null : 'not yet' }));
}

/** The Controls line: where the facts came from. */
export function factsTech(facts: CertFacts | null | undefined): string | null {
  if (!facts) return null;
  if (facts.source !== 'edges' || !facts.cert) return facts.reason ? `edge storage · ${facts.reason}` : null;
  const c = facts.cert;
  return `read from each edge's Caddy storage (${c.issuerKey}/…/*.crt, never a key) · serial ${c.serial} · notBefore ${c.notBefore} · notAfter ${c.notAfter}`;
}
