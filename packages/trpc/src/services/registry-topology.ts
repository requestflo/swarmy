/**
 * Registry topology (security review M16): how nodes reach the built-in
 * registry and the Docker Hub pull-through cache.
 *
 *   mesh      the old topology: :5000/:5001 published on the routing mesh, so
 *             each node's dockerd pulls `localhost:5000` across the
 *             UNENCRYPTED `ingress` overlay (the agent's firewall floor keeps
 *             the ports off public addresses).
 *   loopback  no published port; both services only on the encrypted `swarmy`
 *             overlay; each node pulls through its loopback forwarder
 *             (`@swarmy/core/registry-forwarder`).
 *
 * Every (re)deploy of either service follows ONE rule (`desiredRegistryTopology`):
 *   1. One-way: once either service runs loopback the cluster stays loopback.
 *      Going back would fight the forwarders for the ports.
 *   2. Otherwise move only when EVERY ready swarm node has an online agent
 *      reporting `registryForwarder: on`. A node without one could not pull
 *      from the registry any more.
 * Unknown (a cold hub, a hub without the facts) reads as not ready: the status
 * quo, never a half-move. Pure over hub reads; no DB.
 */
import { REGISTRY_CACHE_SERVICE, REGISTRY_FORWARDER_NETWORK, REGISTRY_HOST_PORTS, REGISTRY_SERVICE } from '@swarmy/core/registry-forwarder';
import type { SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { AgentHub } from '../hub/types';

export type RegistryTopology = 'loopback' | 'mesh';

/** What the rule reads off a live service (both fields optional: older snapshots, test fakes). */
export type LiveNetworking = Partial<Pick<SwarmServiceInfo, 'ports' | 'networks'>>;

/** Publishes :5000 or :5001 (the only way swarmy ever published them is the routing mesh). */
export function publishesRegistryPort(live: LiveNetworking | undefined): boolean {
  return !!live?.ports?.some((p) => p.published !== undefined && REGISTRY_HOST_PORTS.includes(p.published));
}

export function onRegistryOverlay(live: LiveNetworking | undefined): boolean {
  return !!live?.networks?.some((n) => n.name === REGISTRY_FORWARDER_NETWORK);
}

/** Loopback = nothing published AND on the overlay the forwarders reach it over. */
export function liveRegistryTopology(live: LiveNetworking | undefined): RegistryTopology {
  return !publishesRegistryPort(live) && onRegistryOverlay(live) ? 'loopback' : 'mesh';
}

export interface ForwarderAgent {
  swarmNodeId: string;
  forwarder?: 'on' | 'off';
}

/** Every READY swarm node has an online agent that forwards. No ready node known → false. */
export function forwardersReady(nodes: ReadonlyArray<Pick<SwarmNodeInfo, 'swarmNodeId' | 'status'>>, agents: readonly ForwarderAgent[]): boolean {
  const ready = nodes.filter((n) => n.status === 'ready').map((n) => n.swarmNodeId);
  if (!ready.length) return false;
  const on = new Set(agents.filter((a) => a.forwarder === 'on').map((a) => a.swarmNodeId));
  return ready.every((id) => on.has(id));
}

export function desiredRegistryTopology(input: {
  registry?: LiveNetworking;
  cache?: LiveNetworking;
  forwardersReady: boolean;
}): RegistryTopology {
  const moved = [input.registry, input.cache].some((s) => s && liveRegistryTopology(s) === 'loopback');
  return moved || input.forwardersReady ? 'loopback' : 'mesh';
}

type TopologyHub = Pick<AgentHub, 'liveInventory' | 'nodeInventory' | 'onlineNodeIds' | 'swarmNodeIdFor' | 'agentBuildFor'>;

/** The org's live registry + cache services (Docker truth). */
export function liveRegistryServices(hub: Pick<AgentHub, 'liveInventory'>, orgId: string) {
  const services = hub.liveInventory(orgId).services;
  return {
    registry: services.find((s) => s.name === REGISTRY_SERVICE),
    cache: services.find((s) => s.name === REGISTRY_CACHE_SERVICE),
  };
}

/** Online agents of this org's swarm, with their forwarder fact. */
export function forwarderAgents(hub: TopologyHub, orgId: string): { nodes: SwarmNodeInfo[]; agents: ForwarderAgent[] } {
  const nodes = hub.nodeInventory(orgId);
  const ids = new Set(nodes.map((n) => n.swarmNodeId));
  const agents: ForwarderAgent[] = [];
  for (const id of hub.onlineNodeIds()) {
    const swarmNodeId = hub.swarmNodeIdFor(id);
    if (swarmNodeId && ids.has(swarmNodeId)) agents.push({ swarmNodeId, forwarder: hub.agentBuildFor?.(id)?.registryForwarder });
  }
  return { nodes, agents };
}

/** The topology the org's registry and cache must be (re)deployed with right now. */
export function registryTopologyFor(hub: TopologyHub, orgId: string): RegistryTopology {
  let ready = false;
  let live: ReturnType<typeof liveRegistryServices> = { registry: undefined, cache: undefined };
  try {
    live = liveRegistryServices(hub, orgId);
    const { nodes, agents } = forwarderAgents(hub, orgId);
    ready = forwardersReady(nodes, agents);
  } catch {
    // A hub that can't answer: keep the status quo.
  }
  return desiredRegistryTopology({ ...live, forwardersReady: ready });
}

/** Deterministic signature of the topology reconcile's inputs (its per-org gate). */
export function registryTopologySignature(want: RegistryTopology, live: { registry?: LiveNetworking; cache?: LiveNetworking }): string {
  const of = (s: LiveNetworking | undefined) => (s ? liveRegistryTopology(s) : 'absent');
  return `${want}|registry=${of(live.registry)}|cache=${of(live.cache)}`;
}
