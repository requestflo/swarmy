import type { Inventory } from '@swarmy/core';

/**
 * Pure: scope the live inventory to the one app (stack) the canvas shows.
 * Cross-stack links simply don't appear in a single-stack view.
 */
export function filterInventory(inv: Inventory, stack: string): Inventory {
  const projects = inv.projects.filter((p) => p.name === stack);
  const keep = new Set(projects.flatMap((p) => p.serviceIds));
  const services = inv.services.filter((s) => keep.has(s.id));
  const edges = inv.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { projects, services, edges };
}
