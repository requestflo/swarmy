/**
 * The public DNS-over-HTTPS resolvers the domain check asks (owner decisions
 * Q12 + Q13) — pure data, browser-safe, shared by the controller (which asks
 * them), the pure gate in `@swarmy/ingress` domain-verify, and the dashboard's
 * "what the world sees" map.
 *
 * These are ANYCAST services: an answer comes from whichever of the
 * operator's sites is nearest the controller, so `city`/`lat`/`lon` is the
 * OPERATOR'S HOME BASE (where the company is), not where the answer came
 * from. The dashboard says so.
 *
 * Formats: `json` = the `application/dns-json` GET API (`?name=&type=`), which
 * only Cloudflare and Google serve reliably; `wire` = RFC 8484
 * (`?dns=<base64url DNS message>`, `accept: application/dns-message`), which
 * every DoH server speaks.
 */

export type DohFormat = 'json' | 'wire';

export interface DohResolverInfo {
  /** Stable key — the `SWARMY_DOH_RESOLVERS` preset name and the id stored on each check. */
  id: string;
  /** What people call it ("Cloudflare 1.1.1.1"). */
  name: string;
  /** Who runs it. */
  operator: string;
  /** The operator's home city (anycast: not where the answer came from). */
  city: string;
  /** Broad region for grouping ("Europe"). */
  region: string;
  lat: number;
  lon: number;
  /** The DoH endpoint (query string appended per request). */
  url: string;
  format: DohFormat;
}

/** The default set: 12 operators across North America, Europe and Asia. */
export const DOH_RESOLVERS: readonly DohResolverInfo[] = [
  { id: 'cloudflare', name: 'Cloudflare 1.1.1.1', operator: 'Cloudflare', city: 'San Francisco', region: 'North America', lat: 37.77, lon: -122.42, url: 'https://cloudflare-dns.com/dns-query', format: 'json' },
  { id: 'google', name: 'Google 8.8.8.8', operator: 'Google', city: 'Mountain View', region: 'North America', lat: 37.39, lon: -122.08, url: 'https://dns.google/resolve', format: 'json' },
  { id: 'quad9', name: 'Quad9 9.9.9.9', operator: 'Quad9 Foundation', city: 'Zurich', region: 'Europe', lat: 47.37, lon: 8.54, url: 'https://dns.quad9.net/dns-query', format: 'wire' },
  { id: 'opendns', name: 'OpenDNS', operator: 'Cisco', city: 'San Jose', region: 'North America', lat: 37.34, lon: -121.89, url: 'https://doh.opendns.com/dns-query', format: 'wire' },
  { id: 'adguard', name: 'AdGuard DNS', operator: 'AdGuard', city: 'Limassol', region: 'Europe', lat: 34.68, lon: 33.04, url: 'https://dns.adguard-dns.com/dns-query', format: 'wire' },
  { id: 'mullvad', name: 'Mullvad DNS', operator: 'Mullvad VPN', city: 'Gothenburg', region: 'Europe', lat: 57.71, lon: 11.97, url: 'https://dns.mullvad.net/dns-query', format: 'wire' },
  { id: 'controld', name: 'Control D', operator: 'Control D (Windscribe)', city: 'Toronto', region: 'North America', lat: 43.65, lon: -79.38, url: 'https://freedns.controld.com/p0', format: 'wire' },
  { id: 'cira', name: 'CIRA Canadian Shield', operator: 'CIRA', city: 'Ottawa', region: 'North America', lat: 45.42, lon: -75.7, url: 'https://private.canadianshield.cira.ca/dns-query', format: 'wire' },
  { id: 'alidns', name: 'AliDNS 223.5.5.5', operator: 'Alibaba Cloud', city: 'Hangzhou', region: 'Asia', lat: 30.27, lon: 120.16, url: 'https://dns.alidns.com/dns-query', format: 'wire' },
  { id: 'dnspod', name: 'DNSPod doh.pub', operator: 'Tencent', city: 'Shenzhen', region: 'Asia', lat: 22.54, lon: 114.06, url: 'https://doh.pub/dns-query', format: 'wire' },
  { id: 'quad101', name: 'Quad101', operator: 'TWNIC', city: 'Taipei', region: 'Asia', lat: 25.03, lon: 121.57, url: 'https://dns.twnic.tw/dns-query', format: 'wire' },
  { id: 'iij', name: 'IIJ Public DNS', operator: 'IIJ', city: 'Tokyo', region: 'Asia', lat: 35.68, lon: 139.69, url: 'https://public.dns.iij.jp/dns-query', format: 'wire' },
];

/**
 * The two resolvers that must be among the agreeing ones (Q13), when they are
 * configured. id → the address people know them by.
 */
export const DOH_ANCHORS: Readonly<Record<string, string>> = { cloudflare: '1.1.1.1', google: '8.8.8.8' };

/** Resolvers swarmy asks from inside the cluster (not public DoH). */
export const LOCAL_RESOLVERS: readonly string[] = ['system', 'swarmy-dns'];

/** Ids stored by checks before the catalogue existed (the old two-resolver default). */
const LEGACY_IDS: Readonly<Record<string, string>> = { '1.1.1.1': 'cloudflare', '8.8.8.8': 'google' };

/** Canonical id for a stored resolver id (maps the legacy `1.1.1.1`/`8.8.8.8`). */
export function canonicalResolverId(id: string): string {
  return LEGACY_IDS[id] ?? id;
}

/** Catalogue entry for a stored resolver id, or undefined (local / custom URL). */
export function dohResolverInfo(id: string): DohResolverInfo | undefined {
  const key = canonicalResolverId(id);
  return DOH_RESOLVERS.find((r) => r.id === key);
}

/** Is this resolver one of the anchors (1.1.1.1 / 8.8.8.8)? */
export function isAnchorResolver(id: string): boolean {
  return canonicalResolverId(id) in DOH_ANCHORS;
}

// ───────────────────────────────────────────── views ──

/**
 * One resolver's result on the last check, as the dashboard and REST see it:
 * `agrees` — it points at your edges; `cached` — it answered with something
 * else (usually an old answer it still holds; never blocks on its own);
 * `no_answer` — timed out / unreachable; `error` — it answered with an error
 * (HTTP error, SERVFAIL). The last two are left out of the count.
 */
export type ResolverState = 'agrees' | 'cached' | 'no_answer' | 'error';

export interface DomainResolverView {
  /** Catalogue id, `system`, `swarmy-dns`, or a custom resolver's host. */
  id: string;
  name: string;
  operator: string | null;
  /** Operator's home city (anycast — not where the answer came from). Null for local / custom. */
  city: string | null;
  region: string | null;
  lat: number | null;
  lon: number | null;
  /** `local` = the controller's own resolver or swarmy's nameservers; `public` = DoH. */
  tier: 'local' | 'public';
  format: DohFormat | null;
  url: string | null;
  /** One of 1.1.1.1 / 8.8.8.8 — must be among the agreeing ones. */
  anchor: boolean;
  state: ResolverState;
  /** Every A/AAAA address it answered. */
  ips: string[];
  cname: string[];
  nxdomain: boolean;
  error: string | null;
}

/**
 * The go-live gate as last evaluated: at least 3 of every 4 public resolvers
 * that answered point at your edges, and the configured anchors that answered
 * are among them. With no public answer (air-gapped), the local resolvers
 * decide and every one that answered must agree (`basis: 'local'`).
 */
export interface DnsGateView {
  basis: 'public' | 'local' | 'none';
  agreeing: number;
  answering: number;
  needed: number;
  /** Configured anchors (1.1.1.1 / 8.8.8.8), e.g. ['1.1.1.1', '8.8.8.8']. */
  anchors: string[];
  /** Every configured anchor that answered agrees (true when none is configured). */
  anchorsAgree: boolean;
  pass: boolean;
}
