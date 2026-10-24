import { apexOf } from './domain-verify';
import { isWildcardHost, normalizeHostname } from './www';

/**
 * How far a wildcard host reaches. `*.acme.com` covers one registrable
 * domain; `*.com`, `*.co.uk` or `*.github.io` cover everybody's. A login-
 * protected route on such a pattern would let swarmy's forward-auth mint a
 * session code for, and redirect it to, any host under the suffix.
 *
 * swarmy ships no public-suffix list, so the rule is conservative: the base
 * of a wildcard must be at least a registrable domain (one label above a
 * public suffix), where the suffix is
 *  - the last label (`com`, `io`, `dev`), or
 *  - the last two when they are a known two-label suffix (`co.uk`,
 *    `com.au`; the list `apexOf` uses), a generic second level under a
 *    country code (`gov.uk`, `or.jp`, `com.br`), or a shared-hosting suffix
 *    whose subdomains belong to different people (`github.io`, `sslip.io`).
 */

const GENERIC_SECOND_LEVEL = new Set([
  'ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'int', 'ltd', 'mil', 'ne', 'net', 'nic', 'nom', 'or', 'org', 'plc', 'sch',
]);

const SHARED_HOSTING = new Set([
  'appspot.com', 'azurewebsites.net', 'blogspot.com', 'cloudfront.net', 'duckdns.org', 'firebaseapp.com', 'fly.dev',
  'github.io', 'gitlab.io', 'herokuapp.com', 'netlify.app', 'ngrok-free.app', 'ngrok.io', 'nip.io', 'onrender.com',
  'pages.dev', 'sslip.io', 'trycloudflare.com', 'vercel.app', 'web.app', 'workers.dev',
]);

/** How many trailing labels of `name` are (conservatively) its public suffix. */
function suffixLabels(labels: string[]): number {
  if (labels.length < 2) return 1;
  const [sld, tld] = labels.slice(-2) as [string, string];
  const lastTwo = `${sld}.${tld}`;
  // apexOf keeps three labels exactly when the last two are a known suffix.
  const knownTwoLabel = apexOf(`x.${lastTwo}`) === `x.${lastTwo}`;
  const ccGeneric = tld.length === 2 && GENERIC_SECOND_LEVEL.has(sld);
  return knownTwoLabel || ccGeneric || SHARED_HOSTING.has(lastTwo) ? 2 : 1;
}

/** True for a wildcard whose base is a public suffix (`*.com`, `*.co.uk`, `*.github.io`), or a bare `*`. */
export function isBroadWildcard(host: string): boolean {
  const h = normalizeHostname(host);
  if (h === '*') return true;
  if (!isWildcardHost(h)) return false;
  const labels = h.slice(2).split('.').filter(Boolean);
  if (labels.some((l) => l.includes('*'))) return true;
  return labels.length <= suffixLabels(labels);
}
