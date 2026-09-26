import type { CostOverviewView, NodeSummary, ServiceSummary } from '@swarmy/core';
import type { AppItem } from '@/components/apps/use-apps';
import { cardHeight, groupByRegion, type GroupInput } from './map-layout';
import { busiest, reachNote, roleWords, serverApps, sizeWords, type Busy, type ServerAppRow } from './server-words';

export interface MeshPeerLike {
  nodeId: string;
  meshIp: string | null;
  status: string;
}

export interface RegionCoord {
  region: string;
  lat: number;
  lng: number;
}

export type MeshState = 'connected' | 'joining' | 'off';

export interface ServerView {
  node: NodeSummary;
  roles: string;
  size: string;
  busy: Busy | null;
  apps: ServerAppRow[];
  note: string | null;
  mesh: { state: MeshState; ip: string | null };
  /** $ a month from the `swarmy.node.cost` label; null = no price set, undefined = still loading. */
  cost: number | null | undefined;
}

export interface RegionGroup {
  region: string | null;
  lat: number | null;
  lon: number | null;
  servers: ServerView[];
}

export interface EstateInput {
  nodes: NodeSummary[];
  apps: AppItem[];
  servicesByNode: Map<string, ServiceSummary[]> | undefined;
  stackOf: Map<string, string>;
  coords: RegionCoord[] | undefined;
  meshOn: boolean;
  peers: MeshPeerLike[] | undefined;
  cost: CostOverviewView | undefined;
}

/** Every server as its card's words, grouped by region with the region's coordinates. */
export function buildEstate(input: EstateInput): RegionGroup[] {
  const peerOf = new Map((input.peers ?? []).map((p) => [p.nodeId, p]));
  const costOf = new Map((input.cost?.nodes ?? []).map((c) => [c.nodeId, c.monthlyUsd]));
  const servers = input.nodes.map((node): ServerView => {
    const peer = input.meshOn ? peerOf.get(node.id) : undefined;
    const mesh: MeshState = !peer ? 'off' : peer.status.toUpperCase() === 'CONNECTED' ? 'connected' : 'joining';
    return {
      node,
      roles: roleWords(node),
      size: sizeWords(node),
      busy: busiest(node),
      apps: serverApps(input.servicesByNode?.get(node.id) ?? [], input.apps, input.stackOf),
      note: reachNote(node, mesh !== 'off'),
      mesh: { state: mesh, ip: peer?.meshIp ?? null },
      cost: input.cost ? (costOf.get(node.id) ?? null) : undefined,
    };
  });
  return groupByRegion(servers.map((s) => ({ ...s, region: s.node.region }))).map((g) => {
    const c = g.region ? input.coords?.find((r) => r.region === g.region) : undefined;
    return { region: g.region, lat: c?.lat ?? null, lon: c?.lng ?? null, servers: g.servers };
  });
}

/** The layout's input: each region's card heights from what its cards show. */
export function layoutInput(groups: RegionGroup[], o: { tech: boolean; coarse: boolean }): GroupInput[] {
  return groups.map((g) => ({
    region: g.region,
    lat: g.lat,
    lon: g.lon,
    cards: g.servers.map((s) => ({
      id: s.node.id,
      h: cardHeight({ apps: s.apps.length, notes: (s.note ? 1 : 0) + (o.tech ? 1 : 0), coarse: o.coarse }),
    })),
  }));
}

/** Pairs of servers on the private network, for the faint links under the Mesh lens. */
export function meshLinks(groups: RegionGroup[]): { a: string; b: string; ok: boolean }[] {
  const on = groups.flatMap((g) => g.servers).filter((s) => s.mesh.state !== 'off');
  const out: { a: string; b: string; ok: boolean }[] = [];
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      out.push({ a: on[i]!.node.id, b: on[j]!.node.id, ok: on[i]!.mesh.state === 'connected' && on[j]!.mesh.state === 'connected' });
    }
  }
  return out;
}
