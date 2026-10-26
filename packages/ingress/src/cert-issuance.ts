import type { EdgeCertRead } from './edge-certs';

/**
 * How many certificates the edges hold, and how many were issued each day
 * (board 31: "6 issued"). Pure over what each edge's agent read from its own
 * Caddy storage (`edgeCerts`: notBefore per certificate); the controller
 * does the IO. A certificate is counted once however many edges hold it
 * (by fingerprint: a shared store gives every edge the same copy), and an
 * edge's older copy not yet synced is a separate issuance, which it was.
 * Issued = notBefore, the CA's own stamp (Let's Encrypt backdates it about
 * an hour, so a day boundary can shift by that much).
 */

export const ISSUANCE_DAYS = 30;
const DAY = 86_400_000;
/** Caddy's own authority (private addresses, `tls internal`): not a public CA. */
const LOCAL_ISSUER = 'local';

export interface CertIssuance {
  /** Distinct certificates the edges hold now. */
  held: number;
  /** Of those, issued by the edge's own authority rather than a public CA. */
  local: number;
  /** One per UTC day, oldest first, the last {@link ISSUANCE_DAYS} days ending today. Zeros included. */
  days: Array<{ day: string; issued: number }>;
  /** Issued inside that window. */
  inWindow: number;
  /** The newest notBefore (ISO), null with none held. */
  latestAt: string | null;
  /** Edges that answered, out of `edges`. */
  reported: number;
  edges: number;
}

const dayOf = (ms: number): string => new Date(Math.floor(ms / DAY) * DAY).toISOString().slice(0, 10);

export function certIssuance(reads: readonly EdgeCertRead[], now: number, days = ISSUANCE_DAYS): CertIssuance {
  const seen = new Map<string, { notBefore: number; local: boolean }>();
  for (const r of reads) {
    if (r.status !== 'read') continue;
    for (const c of r.certs) {
      const at = Date.parse(c.notBefore);
      if (!Number.isFinite(at)) continue;
      seen.set(c.fingerprint256, { notBefore: at, local: c.issuerKey === LOCAL_ISSUER });
    }
  }
  const today = Math.floor(now / DAY) * DAY;
  const window = Array.from({ length: days }, (_, i) => ({ day: dayOf(today - (days - 1 - i) * DAY), issued: 0 }));
  const index = new Map(window.map((d, i) => [d.day, i]));
  let latest: number | null = null;
  let inWindow = 0;
  for (const { notBefore } of seen.values()) {
    if (latest === null || notBefore > latest) latest = notBefore;
    const i = index.get(dayOf(notBefore));
    if (i !== undefined && notBefore <= now) {
      window[i]!.issued += 1;
      inWindow += 1;
    }
  }
  return {
    held: seen.size,
    local: [...seen.values()].filter((c) => c.local).length,
    days: window,
    inWindow,
    latestAt: latest === null ? null : new Date(latest).toISOString(),
    reported: reads.filter((r) => r.status === 'read').length,
    edges: reads.length,
  };
}
