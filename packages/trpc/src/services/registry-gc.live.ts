/**
 * Registry GC's reads of LIVE Docker truth (hub snapshots, never the DB):
 * where the registry task and its volume are, and everything a server could
 * pull right now — the set the registry pass must never delete from.
 */
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { SWARM_NODE_ID_LABEL } from '@swarmy/core/system-images';
import type { AgentHub } from '../hub/types';
import { bareDigest } from './cicd.service';
import { computePinnedDigests } from './image-gc.service';
import { REGISTRY_SERVICE_NAME } from './registry-auth';
import { registryDataVolume } from './registry-gc.spec';
import { registryTopologyFor, type RegistryTopology } from './registry-topology';

export interface RegistryTarget {
  live: SwarmServiceInfo;
  /** Agent (controller) node id running the registry task — where its volume is. */
  nodeId: string;
  containerId: string;
  swarmNodeId: string;
  volume: string;
  /** A connected manager for service updates. */
  manager: string;
  /** The topology every redeploy of the registry must keep (M16; registry-topology.ts). */
  topology?: RegistryTopology;
}

/** Find the org's registry task, or say why GC can't run this tick. */
export function locateRegistry(hub: AgentHub, orgId: string): RegistryTarget | string {
  const inv = hub.liveInventory(orgId);
  const live = inv.services.find((s) => s.name === REGISTRY_SERVICE_NAME);
  if (!live) return 'registry not running';
  const manager = hub.managerNode(orgId);
  if (!manager) return 'no manager online';
  const volume = registryDataVolume(live);
  if (!volume) return 'registry storage is not a local volume';
  const orgContainers = new Set(inv.containers.map((c) => c.id));
  for (const nodeId of hub.onlineNodeIds()) {
    const c = hub.latestContainers(nodeId).find((x) => orgContainers.has(x.id) && isTaskOf(x, live) && x.state === 'running');
    if (!c) continue;
    const swarmNodeId = c.labels[SWARM_NODE_ID_LABEL] ?? hub.swarmNodeIdFor(nodeId);
    const topology = registryTopologyFor(hub, orgId);
    return swarmNodeId ? { live, nodeId, containerId: c.id, swarmNodeId, volume, manager, topology } : 'registry node unknown';
  }
  return 'registry task not found';
}

export function isTaskOf(c: { serviceId?: string; labels: Record<string, string> }, live: SwarmServiceInfo): boolean {
  return (c.serviceId ?? c.labels['com.docker.swarm.service.id']) === live.id;
}

/** Live pinned digests + any running container (service task or not) + services retained from a disconnected manager. */
export function pinnedForRegistry(hub: AgentHub, orgId: string): Set<string> {
  const pinned = computePinnedDigests(hub, orgId);
  const more = [...hub.lastKnownServices(orgId), ...hub.liveInventory(orgId).containers.filter((c) => c.state === 'running')];
  for (const s of more) if (s.image.includes('@sha256:')) pinned.add(bareDigest(s.image));
  return pinned;
}

/** Every image a service or container references (for the by-tag "floating" repos). */
export function liveImages(hub: AgentHub, orgId: string): string[] {
  const inv = hub.liveInventory(orgId);
  return [...inv.services, ...hub.lastKnownServices(orgId), ...inv.containers].map((s) => s.image);
}
