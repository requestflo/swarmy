import type { Inventory } from '@swarmy/core';

/**
 * Pure: scope the live inventory to a single stack for the drilled-in canvas, or
 * pass it through unchanged for the flat "All services" view. Edges are left
 * intact — `buildGraph` already drops any whose endpoints fall outside the kept
 * services, so cross-stack links simply don't appear in a single-stack view.
 */
export function filterInventory(inv: Inventory, stack: string | null): Inventory {
  if (stack === null) return inv;
  const projects = inv.projects.filter((p) => p.name === stack);
  const keep = new Set(projects.flatMap((p) => p.serviceIds));
  const services = inv.services.filter((s) => keep.has(s.id));
  const edges = inv.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { projects, services, edges };
}
