/**
 * Relays on edges (plans/epic-self-hosted-mesh-and-fleets.md §2.5, M3). Pure.
 *
 * NetBird's combined server runs its own relay + STUN unless `server.relays`
 * is set, and then it runs NEITHER (combined/cmd/config.go
 * `applyRelayDefaults`: external relays return before STUN is enabled). So
 * swarmy switches to edge relays all at once: every edge with a public IPv4
 * runs `swarmy-mesh-relay` (relay + STUN), the control-plane config lists
 * them under `relays` and their STUN under `stuns`, and relayed pairs keep
 * working while the control-plane node is gone.
 *
 * Addressing: one name per edge, `relay.<a-b-c-d>.<base>`, where `base` is
 * the org's wildcard-IP base (its cluster zone, else sslip.io): the name
 * resolves to that edge by construction, no DNS record to create. The edge
 * Caddy serves it (ACME like every other swarmy name) and proxies the
 * WebSocket to the relay on that node's MESH address, so the rendered vhosts
 * are the same on every edge. The NetBird client always dials `/relay`, which
 * is why each relay needs a host of its own.
 *
 * The relay set is identity, not health (last-known edges count): a list
 * change restarts the control plane, and NetBird clients skip a relay they
 * can't reach. The switch itself waits for one healthy relay (the service).
 */
import { MESH_CONTROL_PRIVATE_PORTS } from './server-config';

export const MESH_RELAY_PORT = 33080;
/** Health (loopback) and metrics: next to the listener (9001/9091 are often taken on real hosts). */
export const MESH_RELAY_HEALTH_PORT = 33081;
export const MESH_RELAY_METRICS_PORT = 33082;
export const MESH_RELAY_STUN_PORT = 3478;
/** Ports the relay opens that nobody off-host needs (firewalled like the control plane's). */
export const MESH_RELAY_PRIVATE_PORTS = [MESH_RELAY_PORT, MESH_RELAY_METRICS_PORT, MESH_RELAY_HEALTH_PORT] as const;

/** One edge that can host a relay. */
export interface RelayEdgeInput {
  nodeId: string;
  hostname: string;
  /** The edge's public IPv4 (the caller filters to public addresses). */
  publicIp: string;
  /** Its mesh address (the live peer map, else its advertised swarm address). */
  meshIp: string | null;
}

export interface PlannedRelay {
  nodeId: string;
  hostname: string;
  /** `relay.<a-b-c-d>.<base>`: the edge vhost and the relay's TLS name. */
  host: string;
  /** What peers dial and the relay announces. */
  address: string;
  /** The edge vhost's upstream (`<mesh IP>:33080`). */
  upstream: string;
  /** `stun:<public ip>:3478` for the control-plane config. */
  stun: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** `relay.<a-b-c-d>.<base>`, or null for a malformed IP or base. */
export function relayHostname(publicIp: string, base: string): string | null {
  const b = base.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!IPV4.test(publicIp) || !HOST.test(b)) return null;
  return `relay.${publicIp.replace(/\./g, '-')}.${b}`;
}

/**
 * The relays for these edges: one per public IP (lowest node id wins a tie),
 * sorted by host. An edge with no mesh address can't be fronted by the other
 * edges, so it gets none (on a swarm born on the mesh its advertised swarm
 * address is that address, so this is stable across controller restarts).
 */
export function planEdgeRelays(edges: readonly RelayEdgeInput[], base: string, publicPort = 443): PlannedRelay[] {
  const byIp = new Map<string, PlannedRelay>();
  for (const e of [...edges].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))) {
    const host = relayHostname(e.publicIp, base);
    if (!host || byIp.has(e.publicIp) || !e.meshIp || !IPV4.test(e.meshIp)) continue;
    byIp.set(e.publicIp, {
      nodeId: e.nodeId,
      hostname: e.hostname,
      host,
      address: `rels://${host}:${publicPort}`,
      upstream: `${e.meshIp}:${MESH_RELAY_PORT}`,
      stun: `stun:${e.publicIp}:${MESH_RELAY_STUN_PORT}`,
    });
  }
  return [...byIp.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** What the control-plane config lists once edge relays carry the traffic. */
export interface ExternalRelays {
  addresses: string[];
  stuns: string[];
}

export function externalRelaysOf(planned: readonly PlannedRelay[]): ExternalRelays | null {
  if (!planned.length) return null;
  return { addresses: planned.map((r) => r.address).sort(), stuns: planned.map((r) => r.stun).sort() };
}

/** Sanity: the relay's private ports never collide with the control plane's (same host). */
export function relayPortsClash(): number[] {
  const cp = new Set<number>(MESH_CONTROL_PRIVATE_PORTS);
  return MESH_RELAY_PRIVATE_PORTS.filter((p) => cp.has(p));
}
