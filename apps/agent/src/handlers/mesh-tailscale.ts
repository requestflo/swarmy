/**
 * `tailscale status --json` (Headscale's client) → a `meshState` payload.
 *
 * Relayed is read per peer, the way `tailscale status` itself prints it: an
 * ACTIVE peer with a direct endpoint (`CurAddr`) is peer-to-peer; an active
 * peer without one goes through a DERP relay (`Relay`) or a peer relay
 * (`PeerRelay`). Idle peers say nothing either way, so with no active peer the
 * node's `relayed` is left out (unknown) rather than claimed: the controller
 * keeps it null instead of showing "relayed" (or "direct") on a guess.
 */
import type { MeshStatePayload } from '@swarmy/core/protocol';

interface TsPeer {
  TailscaleIPs?: string[];
  Online?: boolean;
  Active?: boolean;
  CurAddr?: string;
  Relay?: string;
  PeerRelay?: string;
}

interface TsStatus {
  Self?: { TailscaleIPs?: string[]; Online?: boolean };
  BackendState?: string;
  Peer?: Record<string, TsPeer> | null;
}

function firstIpv4(ips: string[] | undefined): string | undefined {
  return ips?.find((ip) => ip.includes('.')) ?? ips?.[0];
}

/** Is this peer's traffic going through a relay right now? `undefined` = idle, can't tell. */
export function tailscalePeerRelayed(p: TsPeer): boolean | undefined {
  if (!p.Active) return undefined;
  if (p.CurAddr) return false;
  return Boolean(p.Relay || p.PeerRelay);
}

export function parseTailscaleStatus(stdout: string, sampledAt: number): MeshStatePayload {
  const j = JSON.parse(stdout) as TsStatus;
  const raw = Object.values(j.Peer ?? {});
  const states = raw.map(tailscalePeerRelayed);
  const known = states.filter((s): s is boolean => s !== undefined);
  return {
    driver: 'headscale',
    meshIp: firstIpv4(j.Self?.TailscaleIPs),
    connected: j.BackendState === 'Running',
    ...(known.length ? { relayed: known.some(Boolean) } : {}),
    advertisedRoutes: [],
    peers: raw.map((p, i) => ({
      meshIp: firstIpv4(p.TailscaleIPs),
      connected: p.Online === true,
      relayed: states[i] === true,
    })),
    sampledAt,
  };
}
