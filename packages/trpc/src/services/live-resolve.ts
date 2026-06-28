import { buildInventory, type InvService } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';

/**
 * Resolve live targets (service name + node, running container) straight from the
 * in-memory Docker inventory — never the DB. Mirrors `service.service`'s
 * `liveService`: Docker is the source of truth, so log streaming and terminal
 * exec address a service by its Docker id (or name), not a Prisma row.
 */

/** Swarm task → owning service id, when the container payload omits `serviceId`. */
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

/** Resolve a service from the LIVE Docker inventory by Docker id (or name). No DB. */
export function resolveLiveService(ctx: OrgContext, idOrName: string): InvService | undefined {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const all = buildInventory(services, containers).services;
  return all.find((s) => s.id === idOrName) ?? all.find((s) => s.name === idOrName);
}

/**
 * { serviceName, nodeId } for a Docker service id — used by log streaming. The
 * node is a connected swarm manager (Docker truth), which can serve
 * `docker service logs` for the whole service.
 */
export async function resolveServiceLogTarget(
  ctx: OrgContext,
  idOrName: string,
): Promise<{ serviceName: string; nodeId: string }> {
  const svc = resolveLiveService(ctx, idOrName);
  if (!svc) throw notFound('service', idOrName);
  const node = await resolveManagerNode(ctx);
  return { serviceName: svc.name, nodeId: node.id };
}

/** A running container + the node it lives on, for terminal exec. */
export interface LiveExecTarget {
  serviceId: string;
  serviceName: string;
  containerId: string;
  nodeId: string;
}

/**
 * Resolve a running container id + its node for a Docker service id, for terminal
 * exec. Scans `latestContainers` across the org's online nodes for a running
 * container whose swarm `serviceId` matches the service's Docker id. Returns
 * `undefined` when the service is unknown or has no running container anywhere.
 */
export function resolveExecTarget(ctx: OrgContext, idOrName: string): LiveExecTarget | undefined {
  const svc = resolveLiveService(ctx, idOrName);
  if (!svc) return undefined;
  // Org-scope the scan: only containers the live inventory attributes to this org.
  const orgContainerIds = new Set(ctx.hub.liveInventory(ctx.activeOrgId).containers.map((c) => c.id));
  for (const nodeId of ctx.hub.onlineNodeIds()) {
    const match = ctx.hub.latestContainers(nodeId).find((c) => {
      if (!orgContainerIds.has(c.id)) return false;
      const sid = c.serviceId ?? c.labels?.[SWARM_SERVICE_ID_LABEL];
      return sid === svc.id && c.state === 'running';
    });
    if (match) return { serviceId: svc.id, serviceName: svc.name, containerId: match.id, nodeId };
  }
  return undefined;
}
