/**
 * `tailscale status --json` (Headscale's client) → a `meshState` payload.
 *
 * Relayed is read per peer, the way `tailscale status` itself prints it: an
 * ACTIVE peer with a direct endpoint (`CurAddr`) is peer-to-peer; an active
 * peer without one goes through a DERP relay (`Relay`) or a peer relay
 * (`PeerRelay`). Idle peers say nothing either way, so with no active peer the
 * node's `relayed` is left out (unknown) rather than claimed: the controller
 * keeps it null instead of showing "relayed" (or "direct") on a guess.
 *
 * Each online peer also carries its link facts (path and bytes; Tailscale's
 * status has no latency), read by `tailscalePeerLinks` (@swarmy/mesh).
 */
import type { MeshStatePayload } from '@swarmy/core/protocol';
import { firstIpv4, nodeRelayed, tailscalePeerLinks, tailscalePeerRelayed } from '@swarmy/mesh';

export { tailscalePeerRelayed };

export function parseTailscaleStatus(stdout: string, sampledAt: number): MeshStatePayload {
  const j = JSON.parse(stdout) as { Self?: { TailscaleIPs?: string[] }; BackendState?: string };
  const links = tailscalePeerLinks(j);
  const relayed = nodeRelayed(links);
  return {
    driver: 'headscale',
    meshIp: firstIpv4(j.Self?.TailscaleIPs),
    connected: j.BackendState === 'Running',
    ...(relayed !== undefined ? { relayed } : {}),
    advertisedRoutes: [],
    peers: links.map((p) => ({
      meshIp: p.meshIp,
      connected: p.connected,
      relayed: p.link?.relayed === true,
      ...(p.lastHandshakeAt ? { lastHandshakeAt: p.lastHandshakeAt } : {}),
      ...(p.link ? { link: p.link } : {}),
    })),
    sampledAt,
  };
}
