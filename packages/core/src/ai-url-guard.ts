/**
 * SSRF guard for AI gateway upstreams. A provider base URL is org-supplied, and
 * the gateway sends the org's stored credential to it — so it must point at a
 * public host, never at the controller's own network (loopback, link-local,
 * cloud metadata, RFC1918, CGNAT, ULA). The one exception is an in-cluster
 * engine the org actually runs (Ollama / vLLM discovered from its live
 * inventory): its service name is passed in `allowHosts`.
 *
 * Pure: DNS resolution is injected (`resolve`) so the check is testable and
 * this module stays browser-safe (no `node:dns` import).
 */

export type HostResolver = (hostname: string) => Promise<string[]>;

export interface CheckProviderUrlOptions {
  /** Hostnames allowed without the address check (the org's in-cluster engines). */
  allowHosts?: Iterable<string>;
  /** Resolve a hostname to its IP addresses. Omit to check literal IPs / names only. */
  resolve?: HostResolver;
  /**
   * Accept a query string. Base URLs refuse one; a fully built request URL
   * (Azure `?api-version=`, Gemini `?alt=sse`) carries one legitimately.
   */
  allowQuery?: boolean;
}

export type CheckProviderUrlResult =
  | { ok: true; url: URL; allowlisted: boolean; addresses: string[] }
  | { ok: false; reason: string };

/** Names that are internal no matter what they resolve to. */
const BLOCKED_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 8 × 16-bit groups, or null. Accepts `::` compression and a dotted-quad tail. */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':')) return null;
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    // Rewrite a dotted-quad tail (::ffff:1.2.3.4) as two hex groups.
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    const hex = (n: number): string => n.toString(16);
    s = `${s.slice(0, lastColon + 1)}${hex((v4[0]! << 8) | v4[1]!)}:${hex((v4[2]! << 8) | v4[3]!)}`;
  }
  const tail: number[] = [];
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    return known === 8 ? [...head, ...tail] : null;
  }
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function v4Blocked(b: number[]): string | null {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return 'unspecified address';
  if (a === 10) return 'private address (10/8)';
  if (a === 127) return 'loopback address';
  if (a === 169 && c === 254) return 'link-local / metadata address';
  if (a === 172 && c >= 16 && c <= 31) return 'private address (172.16/12)';
  if (a === 192 && c === 168) return 'private address (192.168/16)';
  if (a === 100 && c >= 64 && c <= 127) return 'carrier-grade NAT address (100.64/10)';
  if (a === 192 && c === 0 && b[2] === 0) return 'IETF protocol address (192.0.0/24)';
  if (a === 198 && (c === 18 || c === 19)) return 'benchmarking address (198.18/15)';
  if (a >= 224) return 'multicast / reserved address';
  return null;
}

/** Why `ip` is not a routable public address, or null when it is. */
export function blockedAddressReason(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return v4Blocked(v4);
  const g = parseIPv6(ip);
  if (!g) return 'unparseable address';
  if (g.every((x) => x === 0)) return 'unspecified address';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback address';
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96).
  const embedded = (): number[] => [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Blocked(embedded());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embedded());
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local address (fe80::/10)';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'site-local address (fec0::/10)';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'unique-local address (fc00::/7)';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast address';
  return null;
}

/**
 * Validate an AI provider URL: http(s) only, no userinfo, no query/fragment
 * (unless `allowQuery`), and every resolved address public — unless the host
 * is one of the org's in-cluster engines (`allowHosts`).
 */
export async function checkProviderUrl(raw: string, opts: CheckProviderUrlOptions = {}): Promise<CheckProviderUrlResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'only http(s) URLs are allowed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  if (url.hash || raw.includes('#')) return { ok: false, reason: 'a URL fragment is not allowed' };
  if (!opts.allowQuery && (url.search || raw.includes('?'))) return { ok: false, reason: 'a query string is not allowed' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'missing host' };

  const allow = new Set([...(opts.allowHosts ?? [])].map((h) => h.toLowerCase()));
  if (allow.has(host)) return { ok: true, url, allowlisted: true, addresses: [] };

  if (BLOCKED_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { ok: false, reason: `host "${host}" is internal` };
  }
  const literal = parseIPv4(host) ? host : parseIPv6(host) ? host : null;
  let addresses: string[];
  if (literal) {
    addresses = [literal];
  } else if (opts.resolve) {
    try {
      addresses = await opts.resolve(host);
    } catch {
      return { ok: false, reason: `host "${host}" does not resolve` };
    }
    if (addresses.length === 0) return { ok: false, reason: `host "${host}" does not resolve` };
  } else {
    addresses = [];
  }
  for (const a of addresses) {
    const why = blockedAddressReason(a);
    if (why) return { ok: false, reason: `host "${host}" resolves to a ${why}` };
  }
  return { ok: true, url, allowlisted: false, addresses };
}
