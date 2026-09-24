/**
 * The addresses swarmy's nodes are known to serve on, for sign-in origin
 * trust (@swarmy/auth origins.ts, QA-001): each live swarm node's advertise
 * address and its stamped public IP (override first). Only Docker/hub truth
 * feeds this, never a request header. PURE over the hub's node inventory.
 */
import type { SwarmNodeInfo } from '@swarmy/core/protocol';

// Mirrors NODE_PUBLIC_IP_(OVERRIDE_)LABEL in @swarmy/trpc node.service (override wins).
const PUBLIC_IP_OVERRIDE_LABEL = 'swarmy.node.public-ip.override';
const PUBLIC_IP_LABEL = 'swarmy.node.public-ip';

export function servedHostsFrom(nodeLists: Iterable<readonly SwarmNodeInfo[]>): string[] {
  const out = new Set<string>();
  for (const list of nodeLists) {
    for (const n of list) {
      // `addr` is the swarm advertise address — an IP, sometimes with a port.
      const addr = n.addr?.trim().replace(/:\d+$/, '');
      if (addr) out.add(addr);
      const pub = n.labels?.[PUBLIC_IP_OVERRIDE_LABEL] || n.labels?.[PUBLIC_IP_LABEL];
      if (pub) out.add(pub.trim());
    }
  }
  return [...out];
}
