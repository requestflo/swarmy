/**
 * ACME DNS-01 — pure. The only way to get a WILDCARD certificate
 * (`*.acme.com`): Let's Encrypt refuses HTTP-01/TLS-ALPN-01 for wildcards.
 *
 * Primary path — swarmy's OWN nameservers. When the wildcard's base sits in a
 * zone swarmy-dns serves (NS delegated to the ingress+outlet nodes), the edge
 * Caddy's `dns swarmy` provider (docker/caddy-swarmy/dnsprovider) POSTs the
 * challenge to the controller (`/ingress/acme-dns/<orgId>/present`, bearer
 * token read from a Docker secret file — never rendered). The controller
 * checks the name is one of the org's routed hosts inside one of its zones,
 * stages the TXT, and pushes the snapshot to every swarmy-dns node — so
 * whichever nameserver the CA asks answers it. No third-party DNS API.
 *
 * Optional secondary — bring-your-own provider token, only for a zone swarmy
 * does not serve (Cloudflare today: caddy-dns/cloudflare, token read with a
 * `{file.*}` placeholder from a Docker secret — again never rendered).
 *
 * Only wildcards use DNS-01; exact hosts keep HTTP-01/TLS-ALPN-01, which need
 * no credentials at all.
 */
import { z } from 'zod';
import { isWildcardHost, normalizeHostname } from './www';

export const DNS_CHALLENGE_PROVIDERS = ['swarmy', 'cloudflare'] as const;
export type DnsChallengeProvider = (typeof DNS_CHALLENGE_PROVIDERS)[number];
/** Providers a user can bring a token for (swarmy needs none). */
export const BYO_DNS_PROVIDERS = ['cloudflare'] as const;
export type ByoDnsProvider = (typeof BYO_DNS_PROVIDERS)[number];

export const DnsChallengeSchema = z.object({
  /** host → which provider solves its DNS-01 challenge (hosts absent here use HTTP-01/TLS-ALPN). */
  hosts: z.record(z.enum(DNS_CHALLENGE_PROVIDERS)).default({}),
  /** swarmy's own DNS: the controller endpoint + where the edge reads its token. */
  swarmy: z.object({ endpoint: z.string().min(1), tokenFile: z.string().min(1) }).optional(),
  /** BYO Cloudflare: where the edge reads the API token (a Docker secret). */
  cloudflare: z.object({ tokenFile: z.string().min(1) }).optional(),
});
export type DnsChallenge = z.infer<typeof DnsChallengeSchema>;

/** Where the edge task finds the swarmy DNS-01 token (Docker secret target). */
export const ACME_DNS_SECRET_TARGET = 'swarmy-acme-dns';
export const ACME_DNS_TOKEN_FILE = `/run/secrets/${ACME_DNS_SECRET_TARGET}`;
/** Where the edge task finds a BYO provider token. */
export const BYO_DNS_SECRET_TARGET = 'swarmy-acme-dns-byo';
export const BYO_DNS_TOKEN_FILE = `/run/secrets/${BYO_DNS_SECRET_TARGET}`;

const CHALLENGE_PREFIX = '_acme-challenge.';

/** `*.acme.com` / `acme.com` → `acme.com` (the name DNS-01 validates). */
export function challengeBase(host: string): string {
  const h = normalizeHostname(host);
  return isWildcardHost(h) ? h.slice(2) : h;
}

/** The TXT owner a DNS-01 challenge for `host` is published at. */
export function challengeRecordName(host: string): string {
  return `${CHALLENGE_PREFIX}${challengeBase(host)}`;
}

/** The swarmy zone (longest suffix) that contains `name`, if any. */
export function zoneFor(name: string, zones: readonly string[]): string | null {
  const n = normalizeHostname(name);
  let best: string | null = null;
  for (const raw of zones) {
    const z = normalizeHostname(raw);
    if ((n === z || n.endsWith(`.${z}`)) && (!best || z.length > best.length)) best = z;
  }
  return best;
}

export interface DnsChallengePlan {
  hosts: Record<string, DnsChallengeProvider>;
  /** Wildcards no provider can solve (the UI says how to fix it). */
  unsolvable: string[];
}

/**
 * Which wildcard hosts get DNS-01, and through whom. swarmy's own DNS wins
 * whenever the base is in a zone swarmy serves; the BYO token covers the rest.
 */
export function planDnsChallenges(input: {
  hosts: readonly string[];
  swarmyZones: readonly string[];
  byoProvider?: ByoDnsProvider | null;
}): DnsChallengePlan {
  const hosts: Record<string, DnsChallengeProvider> = {};
  const unsolvable: string[] = [];
  for (const raw of [...new Set(input.hosts.map(normalizeHostname))].sort()) {
    if (!isWildcardHost(raw)) continue;
    if (zoneFor(challengeBase(raw), input.swarmyZones)) hosts[raw] = 'swarmy';
    else if (input.byoProvider) hosts[raw] = input.byoProvider;
    else unsolvable.push(raw);
  }
  return { hosts, unsolvable };
}

/** Caddy `tls { … }` lines for a host solved by DNS-01, or null. Pure. */
export function caddyDnsTlsLines(host: string, dc: DnsChallenge | undefined, indent = '  '): string[] | null {
  const provider = dc?.hosts[normalizeHostname(host)];
  if (!provider) return null;
  if (provider === 'swarmy' && dc?.swarmy) {
    return [
      `${indent}tls {`,
      `${indent}  dns swarmy {`,
      `${indent}    endpoint ${dc.swarmy.endpoint}`,
      `${indent}    token_file ${dc.swarmy.tokenFile}`,
      `${indent}  }`,
      // swarmy pushes the TXT to every nameserver before answering the
      // provider, so the CA sees it at once; the timeout only bounds a slow push.
      `${indent}  propagation_timeout 3m`,
      `${indent}}`,
    ];
  }
  if (provider === 'cloudflare' && dc?.cloudflare) {
    // `{file.*}` is a runtime placeholder: the token never enters the adapted JSON.
    return [`${indent}tls {`, `${indent}  dns cloudflare {file.${dc.cloudflare.tokenFile}}`, `${indent}}`];
  }
  return null;
}

export type ChallengeCheck =
  | { ok: true; base: string; zone: string; relName: string }
  | { ok: false; status: 400 | 403; reason: string };

/**
 * May the edge publish a DNS-01 TXT at `fqdn` for this org? Only
 * `_acme-challenge.<base>` where `<base>` (or `*.<base>`) is a host the org
 * routes AND lies inside one of its swarmy zones. Anything else is refused —
 * the endpoint must never become a way to mint certificates for names the org
 * does not serve. Pure.
 */
export function checkChallengeName(input: {
  fqdn: string;
  routedHosts: readonly string[];
  zones: readonly string[];
}): ChallengeCheck {
  const fqdn = normalizeHostname(input.fqdn);
  if (!fqdn.startsWith(CHALLENGE_PREFIX)) {
    return { ok: false, status: 400, reason: `not an ACME challenge name: ${fqdn}` };
  }
  const base = fqdn.slice(CHALLENGE_PREFIX.length);
  if (!base || isWildcardHost(base)) return { ok: false, status: 400, reason: `bad challenge name: ${fqdn}` };
  const routed = new Set(input.routedHosts.map(normalizeHostname));
  if (!routed.has(base) && !routed.has(`*.${base}`)) {
    return { ok: false, status: 403, reason: `${base} is not routed by this org` };
  }
  const zone = zoneFor(base, input.zones);
  if (!zone) return { ok: false, status: 403, reason: `${base} is not in a zone swarmy DNS serves` };
  const relName = fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1));
  return { ok: true, base, zone, relName };
}

/** A DNS-01 TXT value is base64url(SHA-256) — 43 chars. Reject anything else. */
export function isChallengeValue(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
}
