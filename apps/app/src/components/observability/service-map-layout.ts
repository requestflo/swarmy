import type { ServiceMapEdgeView, ServiceMapNodeView } from '@swarmy/core';

/**
 * Pure layered layout for the service map: callers flow left → right.
 * A node's column is its longest path from a root (a service nobody calls);
 * cycles are clamped so the walk always terminates. Columns are centred
 * vertically so small graphs sit balanced in the viewport.
 */

export interface MapPoint {
  x: number;
  y: number;
}

export const MAP_COL_WIDTH = 300;
export const MAP_ROW_HEIGHT = 130;

export function layoutServiceMap(
  nodes: ServiceMapNodeView[],
  edges: ServiceMapEdgeView[],
): Map<string, MapPoint> {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const clean = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);

  const outgoing = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const e of clean) {
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e.to);
    hasIncoming.add(e.to);
  }

  // Longest-path level per node, seeded from the roots (cycle-safe: depth is
  // capped at the node count, and we only revisit when the depth grows).
  const roots = ids.filter((id) => !hasIncoming.has(id));
  const seeds = roots.length > 0 ? roots : ids.slice(0, 1);
  const level = new Map<string, number>();
  const queue: Array<[string, number]> = seeds.map((id) => [id, 0]);
  while (queue.length > 0) {
    const [id, depth] = queue.shift()!;
    const cur = level.get(id);
    if (cur !== undefined && cur >= depth) continue;
    if (depth > ids.length) continue;
    level.set(id, depth);
    for (const next of outgoing.get(id) ?? []) queue.push([next, depth + 1]);
  }
  for (const id of ids) if (!level.has(id)) level.set(id, 0);

  // Column members ordered by traffic (busiest at the top), then centred.
  const byLevel = new Map<number, ServiceMapNodeView[]>();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    (byLevel.get(l) ?? byLevel.set(l, []).get(l)!).push(n);
  }

  const positions = new Map<string, MapPoint>();
  for (const [l, members] of byLevel) {
    members.sort((a, b) => b.callsPerMin - a.callsPerMin || a.id.localeCompare(b.id));
    members.forEach((n, idx) => {
      positions.set(n.id, {
        x: l * MAP_COL_WIDTH,
        y: (idx - (members.length - 1) / 2) * MAP_ROW_HEIGHT,
      });
    });
  }
  return positions;
}
