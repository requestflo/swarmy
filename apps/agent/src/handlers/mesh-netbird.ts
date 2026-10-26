/**
 * `netbird status --json` (inside the `swarmy-netbird` sidecar) → a
 * `meshState` payload, with each peer's link facts (latency, path, bytes)
 * read by `netbirdPeerLinks` (@swarmy/mesh). The field names are NetBird's
 * own (client/status/status.go): a peer's address is `netbirdIp` and its
 * path is `connectionType`, so a node is relayed when any connected link is
 * "Relayed", direct when every one is "P2P", and unknown (left out) with no
 * connected peer, the same rule as Headscale's (mesh-tailscale.ts).
 */
import type { MeshStatePayload } from '@swarmy/core/protocol';
import { netbirdPeerLinks, nodeRelayed } from '@swarmy/mesh';

/** Strip a CIDR prefix (`100.71.108.238/16` → `100.71.108.238`); empty ⇒ undefined (QA-063). */
export function bareMeshIp(ip: string | undefined): string | undefined {
  return ip ? ip.split('/')[0] || undefined : undefined;
}

export interface NetbirdSample {
  state: MeshStatePayload;
  /** This node's `netbirdIp` with its prefix, for the reboot pin (mesh-pin.ts). */
  cidr?: string;
}

export function parseNetbirdStatus(stdout: string, sampledAt: number): NetbirdSample {
  const j = JSON.parse(stdout) as { management?: { connected?: boolean }; netbirdIp?: string };
  const links = netbirdPeerLinks(j);
  const relayed = nodeRelayed(links);
  return {
    cidr: j.netbirdIp || undefined,
    state: {
      driver: 'netbird',
      meshIp: bareMeshIp(j.netbirdIp),
      connected: Boolean(j.management?.connected),
      ...(relayed !== undefined ? { relayed } : {}),
      advertisedRoutes: [],
      peers: links.map((p) => ({
        ...(p.meshIp ? { meshIp: p.meshIp } : {}),
        ...(p.publicKey ? { publicKey: p.publicKey } : {}),
        connected: p.connected,
        relayed: p.link?.relayed === true,
        ...(p.lastHandshakeAt ? { lastHandshakeAt: p.lastHandshakeAt } : {}),
        ...(p.link ? { link: p.link } : {}),
      })),
      sampledAt,
    },
  };
}
