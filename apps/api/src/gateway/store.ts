import type { ContainerInfo, SwarmNodeInfo, SwarmServiceInfo, SwarmState } from '@swarmy/core/protocol';
import type {
  ContainerStatsSnapshot,
  LogLine,
  NodeStatsSnapshot,
  ServiceStateSnapshot,
} from '@swarmy/core/views';

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(value: T): void {
    for (const fn of [...this.listeners]) fn(value);
  }
}

/** Bounded async iterable fed by an emitter; closes on abort. */
export function asyncQueue<T>(signal: AbortSignal): {
  push: (v: T) => void;
  close: () => void;
  iterator: AsyncGenerator<T>;
} {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const close = () => {
    done = true;
    wake?.();
    wake = null;
  };
  if (signal.aborted) done = true;
  else signal.addEventListener('abort', close, { once: true });

  async function* gen(): AsyncGenerator<T> {
    while (!done) {
      if (buffer.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
        if (done) break;
      }
      while (buffer.length) yield buffer.shift() as T;
    }
  }
  return {
    push: (v: T) => {
      if (done) return;
      buffer.push(v);
      wake?.();
      wake = null;
    },
    close,
    iterator: gen(),
  };
}

/** In-memory snapshot rings + pub/sub for live subscriptions (no Postgres). */
export class GatewayStore {
  readonly nodeStats = new Map<string, NodeStatsSnapshot>();
  readonly containers = new Map<string, ContainerInfo[]>();
  readonly containerStats = new Map<string, ContainerStatsSnapshot[]>();
  /** Raw live Docker services per (manager) node — the source of truth for reads. */
  readonly serviceInfo = new Map<string, SwarmServiceInfo[]>();
  /** Which connected nodes are swarm managers (from the agent's serviceState). */
  readonly managers = new Map<string, boolean>();
  /** Live local swarm membership per controllerNodeId (from serviceState). Only
   *  `active` = a working swarm member; anything else = degraded even if online. */
  readonly swarmStates = new Map<string, SwarmState>();
  /** Live swarm node inventory per (manager) controllerNodeId — Docker-truth for nodes. */
  readonly swarmNodes = new Map<string, SwarmNodeInfo[]>();
  /** controllerNodeId → reported hostname (bridge to docker node inventory + swarmNodeId). */
  readonly nodeHostname = new Map<string, string>();
  readonly nodeOrg = new Map<string, string>();
  readonly nodeCpuCount = new Map<string, number>();
  /** Last heartbeat/snapshot time per node (replaces DB Node.lastSeenAt). */
  readonly lastSeen = new Map<string, number>();
  /** Latest per-node edge health telemetry (geo-edge: caddy/dns task liveness). */
  readonly ingressNodeStatus = new Map<
    string,
    { caddyRunning: boolean; dnsRunning: boolean; sampledAt: number }
  >();
  /** Last-known swarm-node + service snapshots retained AFTER a node disconnects —
   *  so ABAC (offline node labels) and dr-reconcile (dead-node placement/volumes)
   *  still have data once the node leaves the hub. */
  readonly lastKnownSwarmNodes = new Map<string, SwarmNodeInfo[]>();
  readonly lastKnownServices = new Map<string, SwarmServiceInfo[]>();

  readonly nodeStatsEvent = new Emitter<{ nodeId: string; snap: NodeStatsSnapshot }>();
  readonly logEvent = new Emitter<{ commandId: string; line: LogLine }>();
  /** A node reported it left the swarm. Future hook: alerts, incidents, re-placement. */
  readonly swarmLeftEvent = new Emitter<{ nodeId: string; orgId: string; swarmState: SwarmState; at: number }>();

  setNodeStats(nodeId: string, snap: NodeStatsSnapshot): void {
    this.nodeStats.set(nodeId, snap);
    this.nodeStatsEvent.emit({ nodeId, snap });
  }

  nodesForOrg(orgId: string): string[] {
    return [...this.nodeOrg.entries()].filter(([, o]) => o === orgId).map(([id]) => id);
  }

  /** Thin per-service state (back-compat) derived from the raw Docker services. */
  serviceStatesForOrg(orgId: string): ServiceStateSnapshot[] {
    return this.liveServicesForOrg(orgId).map((s) => ({
      serviceName: s.name,
      desiredReplicas: s.desiredReplicas ?? null,
      runningReplicas: s.runningReplicas,
      updateStatus: s.updateStatus ?? null,
    }));
  }

  /** Raw live Docker services across the org's nodes, deduped by service id. */
  liveServicesForOrg(orgId: string): SwarmServiceInfo[] {
    const byId = new Map<string, SwarmServiceInfo>();
    for (const nodeId of this.nodesForOrg(orgId)) {
      for (const svc of this.serviceInfo.get(nodeId) ?? []) byId.set(svc.id, svc);
    }
    return [...byId.values()];
  }

  /** All live containers across the org's nodes. */
  containersForOrg(orgId: string): ContainerInfo[] {
    const out: ContainerInfo[] = [];
    for (const nodeId of this.nodesForOrg(orgId)) out.push(...(this.containers.get(nodeId) ?? []));
    return out;
  }

  /** A connected swarm-manager node for the org (Docker truth, not the DB role). */
  managerNodeForOrg(orgId: string): string | undefined {
    return this.nodesForOrg(orgId).find((id) => this.managers.get(id) === true);
  }

  /** ALL connected swarm-manager nodes for the org (for fan-out / pick-any loops). */
  managerNodeIdsForOrg(orgId: string): string[] {
    return this.nodesForOrg(orgId).filter((id) => this.managers.get(id) === true);
  }

  /** Live swarm node inventory across the org's connected managers, deduped by swarm id.
   *  With includeOffline, also folds in last-known nodes for the org's disconnected
   *  agents (so the nodes list + ABAC still see offline-but-enrolled nodes). */
  nodeInventoryForOrg(orgId: string, includeOffline = false): SwarmNodeInfo[] {
    const byId = new Map<string, SwarmNodeInfo>();
    for (const nodeId of this.nodesForOrg(orgId)) {
      for (const n of this.swarmNodes.get(nodeId) ?? []) byId.set(n.swarmNodeId, n);
    }
    if (includeOffline) {
      for (const [nodeId, org] of this.nodeOrg) {
        if (org !== orgId || this.swarmNodes.has(nodeId)) continue;
        for (const n of this.lastKnownSwarmNodes.get(nodeId) ?? []) {
          if (!byId.has(n.swarmNodeId)) byId.set(n.swarmNodeId, { ...n, status: 'down' });
        }
      }
    }
    return [...byId.values()];
  }

  /** Last-known services across the org's nodes (live + retained-on-disconnect) —
   *  for dr-reconcile's stranded-volume detection on dead nodes. */
  lastKnownServicesForOrg(orgId: string): SwarmServiceInfo[] {
    const byId = new Map<string, SwarmServiceInfo>();
    for (const [nodeId, org] of this.nodeOrg) {
      if (org !== orgId) continue;
      for (const s of this.serviceInfo.get(nodeId) ?? this.lastKnownServices.get(nodeId) ?? []) byId.set(s.id, s);
    }
    return [...byId.values()];
  }

  /** Resolve a connected agent's Docker swarm node id via its reported hostname. */
  swarmNodeIdFor(controllerNodeId: string): string | undefined {
    return this.nodeInfoFor(controllerNodeId)?.swarmNodeId;
  }

  /** Full live swarm info (role/status/labels/resources) for an ENROLLMENT node id,
   *  bridged via the hostname it reported. Includes last-known for offline nodes. */
  nodeInfoFor(controllerNodeId: string): SwarmNodeInfo | undefined {
    const host = this.nodeHostname.get(controllerNodeId);
    const orgId = this.nodeOrg.get(controllerNodeId);
    if (!host || !orgId) return undefined;
    return this.nodeInventoryForOrg(orgId, true).find((n) => n.hostname === host);
  }

  /** Controller node ids whose swarm node carries a role label (= 'true').
   *  Roles are Docker node labels: swarmy.node.ingress / swarmy.node.outlet. */
  nodesByRoleForOrg(orgId: string, role: 'ingress' | 'outlet'): string[] {
    const label = role === 'ingress' ? 'swarmy.node.ingress' : 'swarmy.node.outlet';
    return this.nodesForOrg(orgId).filter((nodeId) => this.nodeInfoFor(nodeId)?.labels[label] === 'true');
  }

  /** Region label (swarmy.region) → controller node ids in that region. */
  nodesByRegionForOrg(orgId: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const nodeId of this.nodesForOrg(orgId)) {
      const region = this.nodeInfoFor(nodeId)?.labels['swarmy.region'];
      if (!region) continue;
      const list = out.get(region) ?? [];
      list.push(nodeId);
      out.set(region, list);
    }
    return out;
  }

  forget(nodeId: string): void {
    // Retain last-known node + service state for ABAC (offline labels) and dr-reconcile
    // (dead-node placement) before clearing live telemetry.
    const sn = this.swarmNodes.get(nodeId);
    if (sn) this.lastKnownSwarmNodes.set(nodeId, sn);
    const svc = this.serviceInfo.get(nodeId);
    if (svc) this.lastKnownServices.set(nodeId, svc);
    this.lastSeen.set(nodeId, Date.now());

    this.nodeStats.delete(nodeId);
    this.containers.delete(nodeId);
    this.containerStats.delete(nodeId);
    this.serviceInfo.delete(nodeId);
    this.managers.delete(nodeId);
    this.swarmStates.delete(nodeId);
    // Clear live swarm-node telemetry on disconnect, but keep nodeOrg + nodeHostname
    // so an offline-but-enrolled node still resolves its org/hostname.
    this.swarmNodes.delete(nodeId);
  }

  /** Live local swarm membership of a node; `undefined` for legacy agents. */
  swarmStateFor(nodeId: string): SwarmState | undefined {
    return this.swarmStates.get(nodeId);
  }
}
