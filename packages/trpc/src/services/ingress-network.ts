// Routed services must share an overlay with the edge, or Caddy's `reverse_proxy
// <service>:<port>` resolves nothing (or something else entirely). A user's own
// compose file never declares swarmy's edge network, so before every apply we
// attach any routed service that is missing it — a full-spec update rebuilt from
// the live inspect, so nothing else about the service changes.
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from '../context';
import { resolveManagerNode } from './dispatch.service';
import { readRoutes } from './ingress-routes';
import { promoteSpecFrom } from './releases.service';

/** The overlay the swarmy Caddy controller joins (`ensureCaddyController`'s default). */
export const EDGE_NETWORK = 'swarmy';

/** Routed services (by name) that are not yet on `network`. Pure — exported for tests. */
export function servicesMissingEdge(
  services: { name: string; labels: Record<string, string>; networks: { name: string }[] }[],
  network: string = EDGE_NETWORK,
): string[] {
  return services
    .filter((s) => readRoutes(s.labels).length > 0)
    .filter((s) => !s.networks.some((n) => n.name === network))
    .map((s) => s.name);
}

/**
 * Attach every routed service missing the edge network. Best-effort per
 * service: one failure never blocks the rest of the apply. Returns the names
 * that were attached.
 */
export async function attachRoutedServicesToEdge(ctx: OrgContext): Promise<string[]> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services;
  const missing = servicesMissingEdge(live);
  if (missing.length === 0) return [];
  const node = await resolveManagerNode(ctx);
  const attached: string[] = [];
  for (const name of missing) {
    const svc = live.find((s) => s.name === name);
    if (!svc) continue;
    try {
      const raw = await ctx.hub.dispatch<{ inspect?: unknown }>(node.id, 'service.inspect', { service: name });
      const networks = [...svc.networks.map((n) => n.name), EDGE_NETWORK];
      const spec = promoteSpecFrom(raw?.inspect, svc.image, networks);
      if (!spec) continue;
      await ctx.hub.dispatch(node.id, 'service.deploy', { spec });
      attached.push(name);
    } catch {
      // next reconcile tick retries
    }
  }
  return attached;
}
