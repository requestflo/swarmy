/** The private-network map (board 14) as a pure layout: who sits where, how each link is drawn, and its words. */
import type { PlacedLabel } from './curve-labels';
import { pairKey, type MeshLinkLike } from './mesh-link-words';
import { anyRelayedLink, drawLinks, ON_MAP } from './mesh-graph-links';

/** The fields of `MeshPeerView` (mesh.service.ts) the map reads. */
export interface MeshPeerLike {
  nodeId: string;
  meshIp: string | null;
  status: string;
  lastSeen: string | null;
  /** Reaches its peers through a relay (still end-to-end encrypted); null = not reported yet. */
  relayed: boolean | null;
}

/** How a server is on the network: connected (direct / relayed / not reported), joining, or in trouble. */
export type PeerState = 'direct' | 'relayed' | 'unknown' | 'joining' | 'trouble';
export type LinkKind = 'direct' | 'relayed' | 'unknown' | 'joining';

export interface GraphNode {
  id: string;
  name: string;
  ip: string | null;
  nat: boolean;
  state: PeerState;
  status: string;
  x: number;
  y: number;
}

export interface MeshGraph {
  nodes: GraphNode[];
  links: { id: string; kind: LinkKind; d: string }[];
  /** Latency on the links that reported it ("0.4 ms", "through the relay · 19 ms"), placed clear of the servers. */
  labels: (PlacedLabel & { relayed: boolean })[];
  /** Where the relay sits; only when some server goes through one. */
  relay: { x: number; y: number } | null;
  /** The "behind NAT" zone around NAT'd servers. */
  zone: { x: number; y: number; w: number; h: number } | null;
  width: number;
  height: number;
}

/** Peer statuses on the way in: ENROLLING → ENROLLED → CONNECTED. */
export const JOINING_STATUSES = new Set(['ENROLLING', 'ENROLLED']);

export function stateOf(p: Pick<MeshPeerLike, 'status' | 'relayed'>): PeerState {
  if (JOINING_STATUSES.has(p.status)) return 'joining';
  if (p.status !== 'CONNECTED') return 'trouble';
  return p.relayed === null ? 'unknown' : p.relayed ? 'relayed' : 'direct';
}

const PAD = 24;
const SLOT = 150;
const ROW = 140;
const TOP = 70;
const ZONE_H = 180;
const ZONE_GAP = 56;

/**
 * Lay the map out for a canvas `width` px wide (text never scales; the canvas
 * grows instead). Public servers fill rows across the top, NAT'd servers sit
 * in their zone below with the relay beside it (or in the first row's last
 * slot when the zone leaves no room). Each pair's path is what its ends
 * reported (`links`, from `mesh.links`); a pair nobody reported falls back to
 * the servers' own flags, so every link of a relayed server goes through the
 * relay. Relayed links are drawn through the relay, the rest direct. A
 * joining server reaches toward the nearest connected one.
 */
export function layoutMeshGraph(input: {
  peers: MeshPeerLike[];
  names: Map<string, string>;
  nat: Set<string>;
  width: number;
  links?: readonly MeshLinkLike[];
}): MeshGraph {
  const W = Math.max(input.width, 320);
  const all = input.peers.map((p) => ({ p, nat: input.nat.has(p.nodeId), state: stateOf(p) }));
  const facts = new Map((input.links ?? []).map((l) => [pairKey(l.a, l.b), l]));
  const onIds = new Set(all.filter((a) => ON_MAP.has(a.state)).map((a) => a.p.nodeId));
  const hasRelay = all.some((a) => a.state === 'relayed') || anyRelayedLink(facts, onIds);
  const pub = all.filter((a) => !a.nat);
  const home = all.filter((a) => a.nat);

  // The relay sits left of the NAT zone when there's room (its lines then run
  // up to the public servers without crossing them), else in the first row.
  const zoneW = home.length ? Math.min(W - 2 * PAD, Math.max(300, home.length * SLOT + 40)) : 0;
  const relayBesideZone = hasRelay && home.length > 0 && W - PAD - zoneW - PAD >= SLOT;
  const relayInRow = hasRelay && !relayBesideZone;
  const slots = pub.length + (relayInRow ? 1 : 0);
  const cols = Math.max(1, Math.floor((W - 2 * PAD) / SLOT));
  const perRow = Math.max(1, Math.min(cols, slots));
  const rows = slots ? Math.ceil(slots / perRow) : 0;
  const step = (W - 2 * PAD) / perRow;
  const at = (i: number) => ({ x: PAD + step * ((i % perRow) + 0.5), y: TOP + Math.floor(i / perRow) * ROW + ((i % perRow) % 2 ? 34 : 0) });
  const relayIdx = relayInRow ? perRow - 1 : -1;
  const pubIdx = [...Array(slots).keys()].filter((i) => i !== relayIdx);

  const node = (a: (typeof all)[number], pos: { x: number; y: number }): GraphNode => ({
    id: a.p.nodeId,
    name: input.names.get(a.p.nodeId) ?? a.p.nodeId,
    ip: a.p.meshIp,
    nat: a.nat,
    state: a.state,
    status: a.p.status,
    ...pos,
  });
  const nodes = pub.map((a, i) => node(a, at(pubIdx[i] ?? i)));
  const topH = rows ? TOP + (rows - 1) * ROW + 110 : 0;

  let zone: MeshGraph['zone'] = null;
  if (home.length) {
    zone = { x: W - PAD - zoneW, y: topH + ZONE_GAP, w: zoneW, h: ZONE_H };
    const z = zone;
    home.forEach((a, i) => nodes.push(node(a, { x: z.x + (z.w / home.length) * (i + 0.5), y: z.y + 96 })));
  }
  const relay = relayInRow ? at(relayIdx) : zone && relayBesideZone ? { x: zone.x - SLOT / 2 - 10, y: zone.y + 56 } : null;

  const { links, labels } = drawLinks(nodes, relay, facts, W);
  return { nodes, links, labels, relay, zone, width: W, height: (zone ? zone.y + zone.h : topH) + 20 };
}
