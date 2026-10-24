import type { DnsZoneSnapshot } from '@swarmy/core/protocol';

/**
 * Cluster-zone address synthesis — pure (plans/self-reliance.md B2b).
 *
 * The org's cluster zone answers `<a-b-c-d>.<zone>` and `<anything>.<a-b-c-d>.<zone>`
 * with `A a.b.c.d`, the way sslip.io does, so automatic addresses
 * (`<svc>-<stack>.<edge-ip>.<zone>`) resolve by construction without a
 * third party. The IP label is always the one directly under the apex.
 *
 * Safe defaults (a zone you own is not a public suffix):
 * - Only the cluster's own node addresses (`synth.ips`) are synthesised.
 *   Answering any IP would let a stranger get a certificate for
 *   `<their-ip>.<your zone>` and phish under your name.
 * - Private and reserved IPv4 ranges are refused even when listed: a public
 *   nameserver shouldn't map out your internal network, and ACME can't
 *   validate those names anyway (they get the edge's local CA).
 * - IPv4 only. Node public addresses are IPv4 (`swarmy.node.public-ip`) and
 *   geo answers are IPv4-only, so AAAA on a synthesised name is NODATA.
 * - Dashed, canonical form only (`1-2-3-4`, no leading zeros): one name per IP.
 */

const DASHED = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/;

/** `1-2-3-4` → `1.2.3.4`; null unless every octet is canonical decimal 0–255. */
export function dashedIpv4(label: string): string | null {
  const m = label.match(DASHED);
  if (!m) return null;
  const octets = m.slice(1, 5);
  if (octets.some((o) => (o.length > 1 && o.startsWith('0')) || Number(o) > 255)) return null;
  return octets.join('.');
}

/** [network, prefix length] — IPv4 special-purpose ranges (RFC 6890 and friends). */
const RESERVED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT shared space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function toInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/** A globally routable unicast IPv4 (not private, reserved, multicast or malformed). */
export function isPublicIpv4(ip: string): boolean {
  const n = toInt(ip);
  if (n === null) return false;
  return !RESERVED.some(([net, bits]) => {
    const size = 2 ** (32 - bits);
    const base = toInt(net)!;
    return n >= base && n < base + size;
  });
}

/** The synthesis allow-list for a snapshot: public IPv4s only, sorted, unique. */
export function synthAllowList(ips: readonly string[]): string[] {
  return [...new Set(ips.map((ip) => ip.trim()))].filter(isPublicIpv4).sort();
}

/**
 * The address a name synthesises to in this zone, or null. `fqdn` is
 * lowercase without a trailing dot. Null unless the zone carries `synth`, the
 * label right under the apex is a dashed IPv4, and that IP is allowed.
 */
export function synthesizedAddress(zone: DnsZoneSnapshot, fqdn: string): string | null {
  if (!zone.synth || !fqdn.endsWith(`.${zone.zone}`)) return null;
  const relative = fqdn.slice(0, -(zone.zone.length + 1));
  const label = relative.slice(relative.lastIndexOf('.') + 1);
  const ip = dashedIpv4(label);
  if (!ip || !isPublicIpv4(ip) || !zone.synth.ips.includes(ip)) return null;
  return ip;
}
