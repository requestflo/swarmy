import { isIP } from 'node:net';

/**
 * Client-IP derivation for the controller's request entry.
 *
 * Better Auth keys its rate limiter (and `Session.ipAddress`) on a client IP it
 * reads from request headers. It never sees the TCP socket, so without help it
 * either trusts a client-supplied `X-Forwarded-For` (spoofable → per-attacker
 * limits bypassed) or finds nothing and falls back to ONE shared bucket for every
 * visitor (a burst of bad logins locks everyone out).
 *
 * Trust model:
 *   - The host (apps/api) resolves the IP from Bun's `server.requestIP(req)` — the
 *     real socket peer — and writes it into {@link CLIENT_IP_HEADER}. Better Auth
 *     is configured to read ONLY that header (see `server.ts`).
 *   - Any incoming copy of {@link CLIENT_IP_HEADER} is stripped first, so a client
 *     can never inject it.
 *   - `X-Forwarded-For` is honoured ONLY when the socket peer is inside
 *     `SWARMY_TRUSTED_PROXIES`. The chain is walked right-to-left, skipping hops
 *     that are themselves trusted proxies; the first untrusted hop is the client.
 *     (The leftmost entry is attacker-controlled, so it is never taken blindly.)
 *   - Default trusted set: loopback only (127.0.0.0/8, ::1). Docker overlay /
 *     ingress ranges are NOT trusted by default: the `swarmy` overlay has no fixed
 *     subnet and other workloads can attach to it, and the routing-mesh ingress
 *     network does not add `X-Forwarded-For` at all — trusting it would let any
 *     client spoof its IP. To trust swarmy's Caddy edge, set e.g.
 *     `SWARMY_TRUSTED_PROXIES=$(docker network inspect swarmy -f '{{(index .IPAM.Config 0).Subnet}}')`.
 */
export const CLIENT_IP_HEADER = 'x-swarmy-client-ip';

/** Loopback: a sidecar/proxy on the same host (or `docker run --network host`). */
export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '::1/128'];

interface Cidr {
  bytes: Uint8Array;
  prefix: number;
}

/** Strip brackets/zone and unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`). */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  const family = isIP(ip);
  if (family === 0) return null;
  return family === 6 ? ip.toLowerCase() : ip;
}

function ipToBytes(ip: string): Uint8Array | null {
  const family = isIP(ip);
  if (family === 4) return Uint8Array.from(ip.split('.').map(Number));
  if (family !== 6) return null;
  // Expand `::`; a trailing dotted-quad (e.g. `64:ff9b::1.2.3.4`) becomes 2 groups.
  let text = ip;
  const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (quad?.[1]) {
    const [a, b, c, d] = quad[1].split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -quad[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [left, right] = text.split('::') as [string, string | undefined];
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const groups = right === undefined ? l : [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = Number.parseInt(g || '0', 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  });
  return bytes;
}

/** Parse `ip` or `ip/prefix`; `null` for anything malformed. */
export function parseCidr(value: string): Cidr | null {
  const slash = value.lastIndexOf('/');
  const ip = normalizeIp(slash === -1 ? value : value.slice(0, slash));
  const bytes = ip ? ipToBytes(ip) : null;
  if (!bytes) return null;
  const max = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: max };
  const p = value.slice(slash + 1);
  if (!/^\d+$/.test(p)) return null;
  const prefix = Number(p);
  return prefix <= max ? { bytes, prefix } : null;
}

function inCidr(bytes: Uint8Array, net: Cidr): boolean {
  if (bytes.length !== net.bytes.length) return false;
  let bits = net.prefix;
  for (let i = 0; i < bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) return false;
  }
  return true;
}

export interface TrustedProxies {
  nets: Cidr[];
  /** Entries that failed to parse — the host logs these at boot. */
  invalid: string[];
}

/**
 * Parse `SWARMY_TRUSTED_PROXIES` (comma/space separated IPs or CIDRs). Unset ⇒
 * loopback only. The literal `none` trusts nothing (not even loopback).
 */
export function parseTrustedProxies(raw: string | undefined = process.env.SWARMY_TRUSTED_PROXIES): TrustedProxies {
  const entries =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_TRUSTED_PROXIES
      : raw.trim().toLowerCase() === 'none'
        ? []
        : raw.split(/[\s,]+/).filter(Boolean);
  const nets: Cidr[] = [];
  const invalid: string[] = [];
  for (const e of entries) {
    const net = parseCidr(e);
    if (net) nets.push(net);
    else invalid.push(e);
  }
  return { nets, invalid };
}

export function isTrustedProxy(ip: string, trusted: TrustedProxies): boolean {
  const bytes = ipToBytes(ip);
  return !!bytes && trusted.nets.some((n) => inCidr(bytes, n));
}

/**
 * The client IP for a request.
 *
 * @param socketIp the TCP peer (Bun `server.requestIP(req)?.address`).
 * @param headers  the incoming request headers.
 * @param trusted  parsed `SWARMY_TRUSTED_PROXIES`.
 * @returns the normalized client IP, or `null` when the socket peer is unknown.
 */
export function resolveClientIp(
  socketIp: string | null | undefined,
  headers: Headers,
  trusted: TrustedProxies,
): string | null {
  const peer = normalizeIp(socketIp);
  if (!peer) return null;
  if (!isTrustedProxy(peer, trusted)) return peer;
  const xff = headers.get('x-forwarded-for');
  if (!xff) return peer;
  const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
  let client = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]);
    // A malformed hop means the chain beyond it can't be verified: stop at the
    // last hop we could (a trusted proxy's address — coarse, but never spoofed).
    if (!hop) break;
    client = hop;
    if (!isTrustedProxy(hop, trusted)) break;
  }
  return client;
}

/**
 * Return `req` with {@link CLIENT_IP_HEADER} set to the resolved client IP, and
 * any client-supplied copy of it removed. The body stream is carried over
 * untouched; the input `req` must not be read afterwards.
 */
export function withClientIp(req: Request, socketIp: string | null | undefined, trusted: TrustedProxies): Request {
  const ip = resolveClientIp(socketIp, req.headers, trusted);
  const incoming = req.headers.get(CLIENT_IP_HEADER);
  if (incoming === null && ip === null) return req;
  // Clone, then edit the clone's own headers. (Passing `{ headers }` as init is
  // unsafe on Bun: an init Headers that ends up empty is ignored and the
  // original — spoofed — headers are inherited.)
  const out = new Request(req);
  out.headers.delete(CLIENT_IP_HEADER);
  if (ip) out.headers.set(CLIENT_IP_HEADER, ip);
  return out;
}
