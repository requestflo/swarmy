/**
 * Public IP self-detection (geo-edge). The DNS layer answers queries with node
 * public IPs, so every node must know its own. Outbound HTTPS checks beat
 * inspecting interfaces (NAT'd VPSes rarely hold their public address locally).
 * The controller cross-checks our report against the websocket source address
 * and stamps the `swarmy.node.public-ip` node label; a manual override label
 * always wins — so a wrong detection here is recoverable, never fatal.
 */

const PROVIDERS = ['https://checkip.amazonaws.com', 'https://api.ipify.org'];
const TIMEOUT_MS = 2500;
const REDETECT_INTERVAL_MS = 60 * 60 * 1000;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPublicIpv4(text: string): boolean {
  const m = text.match(IPV4);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a = 0, b = 0] = octets;
  // Reject obviously non-public ranges (loopback, RFC1918, link-local, CGN).
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

let cached: { ip: string | undefined; at: number } | undefined;

/** Detect this node's public IPv4 (cached, re-detected hourly). */
export async function detectPublicIp(): Promise<string | undefined> {
  if (cached && Date.now() - cached.at < REDETECT_INTERVAL_MS) return cached.ip;
  for (const url of PROVIDERS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (isPublicIpv4(ip)) {
        cached = { ip, at: Date.now() };
        return ip;
      }
    } catch {
      // provider unreachable — try the next
    }
  }
  // Negative result is cached too: don't hammer providers from an offline node.
  cached = { ip: undefined, at: Date.now() };
  return undefined;
}

/** Test hook. */
export function resetPublicIpCache(): void {
  cached = undefined;
}
