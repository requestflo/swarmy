/**
 * Public-IP helpers shared by the agent (self-detection) and the controller
 * (the source address it sees on an agent's WSS connection) — geo-edge B8 in
 * plans/self-reliance.md.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Is `text` a publicly routable IPv4 literal? Rejects loopback, RFC1918,
 * link-local, CGNAT (100.64/10, also the Tailscale/NetBird mesh range), the
 * "this network" block, multicast/reserved (224+) and the documentation-free
 * broadcast. IPv6 is out of scope (the node public-ip label is IPv4).
 */
export function isPublicIpv4(text: string | null | undefined): boolean {
  if (!text) return false;
  const m = text.trim().match(IPV4);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a = 0, b = 0] = octets;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** Unwrap an IPv4-mapped IPv6 socket address (`::ffff:1.2.3.4` → `1.2.3.4`). */
export function unmapIpv4(addr: string | null | undefined): string | undefined {
  if (!addr) return undefined;
  return addr.trim().replace(/^::ffff:/i, '');
}

/** The public IPv4 an observed socket/proxy address carries, else undefined. */
export function observedPublicIpv4(addr: string | null | undefined): string | undefined {
  const ip = unmapIpv4(addr);
  return ip && isPublicIpv4(ip) ? ip : undefined;
}

/** Third-party IP-echo services — the agent's LAST resort (after the controller's view). */
export const DEFAULT_PUBLIC_IP_ECHO = ['https://checkip.amazonaws.com', 'https://api.ipify.org'] as const;

/**
 * Parse `SWARMY_PUBLIC_IP_ECHO`: unset → {@link DEFAULT_PUBLIC_IP_ECHO};
 * empty / `off` / `none` → no echo at all (air-gapped: the controller's view
 * or the manual override label only); otherwise a comma list of http(s) URLs
 * that return the caller's IP as plain text (e.g. an echo on your own edge).
 */
export function parsePublicIpEcho(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_PUBLIC_IP_ECHO];
  const v = raw.trim();
  if (v === '' || v === 'off' || v === 'none') return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^https?:\/\/[^\s]+$/i.test(x));
}
