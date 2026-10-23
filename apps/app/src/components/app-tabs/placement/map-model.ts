import type { InvService, NodeSummary } from '@swarmy/core';

/**
 * The placement map (board AppPlacement): servers grouped by region, each
 * with a marker per part of this app that has a copy there. A per-region
 * copy (`web-eu-west`) is marked as its part (`web`). Placement is which
 * services `services.list({ nodeId })` reports per server — presence, not
 * counts. PURE — unit-tested in placement-model.test.ts.
 */

export interface MapServer {
  node: NodeSummary;
  /** Parts of this app with a copy here (short names, sorted). */
  parts: string[];
  nat: boolean;
}

export interface MapRegion {
  /** `swarmy.region`; null = servers with no region. */
  region: string | null;
  servers: MapServer[];
}

/** service id → the part it is a copy of, for this app's services and their per-region copies. */
export function partsById(services: InvService[], stack: string): Map<string, string> {
  const short = (n: string): string => (n.startsWith(`${stack}_`) ? n.slice(stack.length + 1) : n);
  const out = new Map<string, string>();
  for (const s of services) {
    if (s.stack !== stack || s.name.endsWith('--canary')) continue;
    out.set(s.id, short(s.regionParent ?? s.name));
  }
  return out;
}

/** `natIds`: servers behind NAT (their `swarmy.node.reachability` label, read per server). */
export function buildMap(nodes: NodeSummary[], servicesByNode: Map<string, Array<{ id: string }>>, parts: Map<string, string>, natIds: Set<string>): MapRegion[] {
  const byRegion = new Map<string | null, MapServer[]>();
  for (const node of nodes) {
    const here = [...new Set((servicesByNode.get(node.id) ?? []).map((s) => parts.get(s.id)).filter((p): p is string => !!p))].sort();
    const region = node.region ?? null;
    const list = byRegion.get(region) ?? [];
    list.push({ node, parts: here, nat: natIds.has(node.id) });
    byRegion.set(region, list);
  }
  return [...byRegion.entries()]
    .map(([region, servers]) => ({ region, servers: servers.sort((a, b) => a.node.name.localeCompare(b.node.name)) }))
    .sort((a, b) => (a.region === null ? 1 : b.region === null ? -1 : a.region.localeCompare(b.region)));
}

/** The regions where `part` has a copy today. */
export function regionsOf(map: MapRegion[], part: string): string[] {
  return map.filter((r) => r.region && r.servers.some((s) => s.parts.includes(part))).map((r) => r.region!);
}
