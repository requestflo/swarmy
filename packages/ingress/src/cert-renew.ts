import type { IngressConfig } from './types';

/**
 * Renew now (board 30): may this address's certificate be re-issued early,
 * and the render without it. Pure; the controller does the IO.
 *
 * Rate limit, per host: at most once an hour and three times a week. Let's
 * Encrypt allows five certificates for the same set of names a week and five
 * failed validations per name an hour; a renew that fails (CAA, DNS) spends
 * the second, one that works spends the first, and Caddy's own renewals need
 * room in the same budget. Once an hour can never trip the failure limit;
 * three a week leaves two for Caddy.
 */

export const RENEW_MIN_GAP_MS = 60 * 60_000;
export const RENEW_WEEK_MAX = 3;
const WEEK_MS = 7 * 86_400_000;

export type RenewBlock =
  | 'tls_off'
  | 'own_cert'
  | 'shared_store'
  | 'no_cert'
  | 'wildcard'
  | 'local_ca'
  | 'old_agent'
  | 'caa'
  | 'rate'
  | 'busy';

export type RenewEligibility =
  | { available: true }
  | { available: false; why: RenewBlock; reason: string; retryAt?: string };

/** Earlier asks (epoch ms) → whether another is allowed now. */
export function renewRateLimit(attempts: readonly number[], now: number): { ok: true } | { ok: false; retryAt: number; reason: string } {
  const week = attempts.filter((t) => now - t < WEEK_MS).sort((a, b) => a - b);
  const last = week.at(-1);
  if (last !== undefined && now - last < RENEW_MIN_GAP_MS) {
    return { ok: false, retryAt: last + RENEW_MIN_GAP_MS, reason: 'It was renewed early less than an hour ago.' };
  }
  if (week.length >= RENEW_WEEK_MAX) {
    return { ok: false, retryAt: week[week.length - RENEW_WEEK_MAX]! + WEEK_MS, reason: `It was renewed early ${RENEW_WEEK_MAX} times this week already.` };
  }
  return { ok: true };
}

export interface RenewAsk {
  tls: 'auto' | 'off' | 'custom';
  /** The org's certificate store (`shared` across edge-per-node edges, else each edge's own). */
  store: 'shared' | 'local';
  cert: { issuerKey: string; wildcard: string | null } | null;
  /** Every edge holding it advertised `edgeCertRenew`. */
  agentsReady: boolean;
  /** CAA lets the CA issue (`null`: not checked or unknown, not a block). */
  caaAllows: boolean | null;
  attempts: readonly number[];
  inFlight: boolean;
  now: number;
}

/** Whether Renew now is offered, and in plain words why not. The order is the order a person would fix things. */
export function renewEligibility(a: RenewAsk): RenewEligibility {
  const no = (why: RenewBlock, reason: string, retryAt?: number): RenewEligibility => ({
    available: false,
    why,
    reason,
    ...(retryAt !== undefined ? { retryAt: new Date(retryAt).toISOString() } : {}),
  });
  if (a.tls === 'off') return no('tls_off', 'HTTPS is off for this address.');
  if (a.tls === 'custom') return no('own_cert', 'This address uses your own certificate, so swarmy does not renew it.');
  if (a.store === 'shared') {
    return no('shared_store', 'Front doors share one certificate store, and each would load the old certificate back from it, so it cannot be renewed early here. It still renews itself.');
  }
  if (!a.cert) return no('no_cert', 'No front door holds a certificate for it yet.');
  if (a.cert.wildcard) return no('wildcard', `It is covered by the wildcard ${a.cert.wildcard}; renewing that touches every address under it, so it is not offered per address.`);
  if (!a.cert.issuerKey.includes('acme')) return no('local_ca', "It is swarmy's own local certificate; it renews itself and costs nothing.");
  if (!a.agentsReady) return no('old_agent', 'The agent on the front door predates Renew now; update it first.');
  if (a.caaAllows === false) return no('caa', 'Your DNS CAA records do not let the certificate authority issue for it, so a renew would fail.');
  if (a.inFlight) return no('busy', 'A renew for it is already running.');
  const rate = renewRateLimit(a.attempts, a.now);
  if (!rate.ok) return no('rate', `${rate.reason} Renewing early spends one of your 5-a-week Let's Encrypt certificates for this name.`, rate.retryAt);
  return { available: true };
}

/** The org's config with `host` left out (its routes, redirects and controller vhosts). */
export function withoutHost(config: IngressConfig, host: string): IngressConfig {
  const h = host.toLowerCase();
  return {
    ...config,
    domains: config.domains.filter((d) => d.domain.toLowerCase() !== h),
    controllerVhosts: config.controllerVhosts.filter((v) => v.domain.toLowerCase() !== h),
    ...(config.hostRedirects ? { hostRedirects: config.hostRedirects.filter((r) => r.from.toLowerCase() !== h) } : {}),
  };
}
