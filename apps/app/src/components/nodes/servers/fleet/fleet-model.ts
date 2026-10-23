import { SYSTEM_STACK, SYSTEM_STACK_LABEL, UNGROUPED } from '@swarmy/core';
import type { InvService, Inventory, ServiceSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { MeshPeerLike, MeshState, RegionCoord } from '@/components/estate-map/estate-model';
import { groupByRegion } from '@/components/estate-map/map-layout';
import type { FleetServer } from '../use-fleet';

/**
 * The Servers map's model, pure: each server's three rings (CPU, memory,
 * disk), its badges, its place on the private network and the services on
 * it as chips, grouped by region with the region's coordinates. The layout
 * itself is the estate map's (`estate-map/map-layout.ts`).
 */

export interface Rings {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
}

export interface ServiceChip {
  id: string;
  /** The Docker service name (what a move is asked for). */
  name: string;
  /** "web" for `storefront_web`. */
  short: string;
  app: string | null;
  tone: Tone;
  word: string;
  /** swarmy's own parts (the system stack). */
  system: boolean;
  inv: InvService | null;
}

export interface FleetView {
  server: FleetServer;
  rings: Rings;
  nat: boolean;
  mesh: { state: MeshState; ip: string | null };
  /** Everything on this server; undefined until placement answers. */
  services: ServiceChip[] | undefined;
}

export interface FleetGroup {
  region: string | null;
  lat: number | null;
  lon: number | null;
  servers: FleetView[];
}

const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/** CPU, memory and disk in use, 0..100, from the latest live sample (null = no number). */
export function ringsOf(s: FleetServer): Rings {
  const l = s.live;
  const cpu = l ? l.cpuPercent : (s.node.live?.cpuPercent ?? null);
  const mem = l?.memTotalBytes ? (l.memUsedBytes / l.memTotalBytes) * 100 : (s.node.live?.memPercent ?? null);
  return { cpu: cpu === null ? null : clampPct(cpu), mem: mem === null ? null : clampPct(mem), disk: s.diskPct };
}

/** Behind NAT: the reachability label (the operator's override wins). */
export function isNat(labels: Record<string, string> | undefined): boolean {
  const v = labels?.['swarmy.node.reachability.override'] || labels?.['swarmy.node.reachability'];
  return v === 'nat';
}

const STATUS: Record<string, { tone: Tone; word: string }> = {
  running: { tone: 'ok', word: 'Running' },
  degraded: { tone: 'warn', word: 'Needs you' },
  deploying: { tone: 'info', word: 'Deploying' },
  pending: { tone: 'info', word: 'Deploying' },
  failing: { tone: 'bad', word: 'Failing' },
  failed: { tone: 'bad', word: 'Failing' },
  idle: { tone: 'idle', word: 'Asleep' },
  stopped: { tone: 'idle', word: 'Stopped' },
};

/** One service as a chip: its short name, its app and its status (the live inventory wins). */
export function chipOf(svc: ServiceSummary, inv: InvService | undefined): ServiceChip {
  const app = inv ? (inv.stack === UNGROUPED ? null : inv.stack) : svc.stackId;
  const name = inv?.name ?? svc.name;
  const short = app && name.startsWith(`${app}_`) ? name.slice(app.length + 1) : name;
  const st = STATUS[inv?.status ?? svc.status] ?? { tone: 'idle' as Tone, word: 'Unknown' };
  const system = app === SYSTEM_STACK || inv?.labels[SYSTEM_STACK_LABEL] === 'true';
  return { id: svc.id, name, short, app, tone: st.tone, word: st.word, system, inv: inv ?? null };
}

export interface FleetInput {
  servers: FleetServer[];
  coords: RegionCoord[] | undefined;
  meshOn: boolean;
  peers: MeshPeerLike[] | undefined;
  labelsOf: Map<string, Record<string, string>>;
  servicesByNode: Map<string, ServiceSummary[]> | undefined;
  inventory: Inventory | undefined;
}

/** Every server as its map tile's model, grouped by region (labelled first, "no region" last). */
export function buildFleet(input: FleetInput): FleetGroup[] {
  const peerOf = new Map((input.peers ?? []).map((p) => [p.nodeId, p]));
  const invOf = new Map((input.inventory?.services ?? []).map((s) => [s.id, s]));
  const views = input.servers.map((server): FleetView => {
    const id = server.node.id;
    const peer = input.meshOn ? peerOf.get(id) : undefined;
    const state: MeshState = !peer ? 'off' : peer.status.toUpperCase() === 'CONNECTED' ? 'connected' : 'joining';
    const here = server.node.status === 'offline' ? [] : input.servicesByNode?.get(id);
    return {
      server,
      rings: ringsOf(server),
      nat: isNat(input.labelsOf.get(id)),
      mesh: { state, ip: peer?.meshIp ?? null },
      services: here?.map((s) => chipOf(s, invOf.get(s.id))),
    };
  });
  return groupByRegion(views.map((v) => ({ ...v, region: v.server.node.region }))).map((g) => {
    const c = g.region ? input.coords?.find((r) => r.region === g.region) : undefined;
    return { region: g.region, lat: c?.lat ?? null, lon: c?.lng ?? null, servers: g.servers };
  });
}

/** Pairs of servers on the private network: the dashed links between tiles. */
export function fleetLinks(groups: FleetGroup[]): { a: string; b: string; ok: boolean }[] {
  const on = groups.flatMap((g) => g.servers).filter((s) => s.mesh.state !== 'off');
  const out: { a: string; b: string; ok: boolean }[] = [];
  on.forEach((x, i) =>
    on.slice(i + 1).forEach((y) => out.push({ a: x.server.node.id, b: y.server.node.id, ok: x.mesh.state === 'connected' && y.mesh.state === 'connected' })),
  );
  return out;
}

/** Your services on a tile (swarmy's own parts stay in the inspector). */
export const TILE_CHIPS = 4;

export function yours(v: FleetView): ServiceChip[] | undefined {
  return v.services?.filter((c) => !c.system);
}

/**
 * Tile height from what it shows (fleet-tile.tsx): padding, the 80px ring
 * header, an optional tech line, one row per chip (+ "more"), 44px rows on
 * touch screens.
 */
export function tileHeight(o: { chips: number; tech: boolean; coarse: boolean }): number {
  const rows = Math.max(1, Math.min(o.chips, TILE_CHIPS) + (o.chips > TILE_CHIPS ? 1 : 0));
  return 112 + (o.tech ? 28 : 0) + rows * (o.coarse ? 50 : 34);
}
