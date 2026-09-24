/**
 * Public IP self-detection (geo-edge). The DNS layer answers queries with node
 * public IPs, so every node must know its own. Order of preference
 * (plans/self-reliance.md B8 — no default dependency on someone else's cloud):
 *
 *  1. The controller's view: the source address it saw on this agent's WSS
 *     connection, returned in `registerAck.observedPublicIp` (only when public).
 *  2. Third-party IP-echo services (`SWARMY_PUBLIC_IP_ECHO`; empty/off → none),
 *     a LAST resort for nodes that reach the controller over a private path.
 *  3. Nothing — the manual `swarmy.node.public-ip.override` label (which always
 *     wins on the controller) is the operator's fix.
 */
import { isPublicIpv4 } from '@swarmy/core';
import { env } from './env';

const TIMEOUT_MS = 2500;
const REDETECT_INTERVAL_MS = 60 * 60 * 1000;

let observed: string | undefined;
let cached: { ip: string | undefined; at: number } | undefined;

/** Record the controller-observed address from a registerAck (undefined clears it). */
export function setObservedPublicIp(ip: string | undefined): void {
  observed = isPublicIpv4(ip) ? ip!.trim() : undefined;
}

/** Last controller-observed public IP, if any. */
export function observedPublicIp(): string | undefined {
  return observed;
}

type FetchText = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * This node's public IPv4: the controller's view first, else the echo
 * services (cached, re-detected hourly — a negative result too, so an offline
 * node never hammers them).
 */
export async function detectPublicIp(
  opts: { providers?: readonly string[]; fetchImpl?: FetchText } = {},
): Promise<string | undefined> {
  if (observed) return observed;
  if (cached && Date.now() - cached.at < REDETECT_INTERVAL_MS) return cached.ip;
  const providers = opts.providers ?? env.PUBLIC_IP_ECHO;
  const doFetch: FetchText = opts.fetchImpl ?? ((url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
  for (const url of providers) {
    try {
      const res = await doFetch(url);
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
  cached = { ip: undefined, at: Date.now() };
  return undefined;
}

/** Test hook. */
export function resetPublicIpCache(): void {
  cached = undefined;
  observed = undefined;
}
