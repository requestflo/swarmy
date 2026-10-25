/**
 * When Caddy will renew a certificate, and the renewals swarmy has seen
 * (board 30, Renewals). Pure.
 *
 * Caddy (certmagic) renews a managed certificate once a third of its
 * lifetime is left (`RenewalWindowRatio` 1/3, checked every 10 minutes), so a
 * 90-day Let's Encrypt certificate renews about 30 days before it expires and
 * a shorter one proportionally sooner. Let's Encrypt can also suggest a
 * different moment through ACME Renewal Information (ARI), which Caddy
 * follows, so the date is "about", never a promise.
 *
 * A certificate does not say whether it replaced another, so a renewal is
 * only known when a later read shows a newer notBefore than an earlier one:
 * the history is what this controller saw, not the CA's record.
 */

/** certmagic's default renewal window: renew with this fraction of the lifetime left. */
export const CADDY_RENEWAL_RATIO = 1 / 3;
/** At most this many renewals are kept per host. */
export const RENEWALS_KEPT = 5;

const DAY = 86_400_000;
const BACKDATE_MS = 2 * 3_600_000;

export interface RenewalWindow {
  /** When Caddy starts trying to renew (ISO): notAfter − lifetime / 3. */
  renewAt: string;
  /** The certificate's whole lifetime in days (90 for Let's Encrypt today). */
  lifetimeDays: number;
  /** `ahead`: not due yet · `due`: inside the window, Caddy is renewing (and retries) · `expired`. */
  state: 'ahead' | 'due' | 'expired';
  /** Whole days until `renewAt` (0 once due). */
  daysUntil: number;
}

export function renewalWindow(notBefore: string, notAfter: string, now = Date.now()): RenewalWindow | null {
  const from = Date.parse(notBefore);
  const to = Date.parse(notAfter);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  const renewAt = to - (to - from) * CADDY_RENEWAL_RATIO;
  return {
    renewAt: new Date(renewAt).toISOString(),
    lifetimeDays: Math.round((to - from) / DAY),
    state: now >= to ? 'expired' : now >= renewAt ? 'due' : 'ahead',
    daysUntil: Math.max(0, Math.ceil((renewAt - now) / DAY)),
  };
}

/** The certificate a read showed for a host. */
export interface SeenCert {
  notBefore: string;
  notAfter: string;
  serial: string;
  issuer: string | null;
}

/** One renewal seen: the new certificate's issue time, and the one it replaced. */
export interface RenewalSeen {
  at: string;
  issuer: string | null;
  replaced: string;
  /** `request`: after someone asked (Renew now) · `automatic`: Caddy did it on its own. */
  by: 'automatic' | 'request';
}

export interface CertHistory {
  current: SeenCert | null;
  /** Newest first, at most {@link RENEWALS_KEPT}. */
  renewals: RenewalSeen[];
  /** Set by a successful Renew now; the next renewal seen is credited to it. */
  requestedAt?: string;
}

export const EMPTY_HISTORY: CertHistory = { current: null, renewals: [] };

/**
 * Fold one read into the history. A newer notBefore with another serial is a
 * renewal; an older one (an edge still holding the previous copy) never
 * moves the history back.
 */
export function noteCert(h: CertHistory, seen: SeenCert): CertHistory {
  const cur = h.current;
  if (!cur) return { ...h, current: seen };
  if (seen.serial === cur.serial || seen.notBefore <= cur.notBefore) return h;
  // Let's Encrypt backdates notBefore by an hour, so allow two before the ask.
  const byRequest = h.requestedAt !== undefined && Date.parse(seen.notBefore) >= Date.parse(h.requestedAt) - BACKDATE_MS;
  const renewal: RenewalSeen = { at: seen.notBefore, issuer: seen.issuer, replaced: cur.notBefore, by: byRequest ? 'request' : 'automatic' };
  return { current: seen, renewals: [renewal, ...h.renewals].slice(0, RENEWALS_KEPT) };
}
