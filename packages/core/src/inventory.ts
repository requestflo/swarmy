import type { ContainerInfo, SwarmServiceInfo } from './protocol';

/**
 * Pure projection of live Docker state into the swarmy hierarchy + link graph.
 *
 * Docker is the source of truth: a "project" is a Docker **stack** (the native
 * `com.docker.stack.namespace` label); services without one fall into a single
 * "(ungrouped)" project. Edges are *inferred*, never declared:
 *   - network: two services sharing a non-system overlay network are linked.
 *   - depends: a service whose env references another service's name/alias.
 */
export const STACK_LABEL = 'com.docker.stack.namespace';
export const SCALE_TO_ZERO_LABEL = 'swarmy.scaleToZero.enabled';
export const SCALE_TO_ZERO_TARGET_LABEL = 'swarmy.scaleToZero.targetReplicas';
export const SCALE_TO_ZERO_IDLE_LABEL = 'swarmy.scaleToZero.idleSeconds';
/**
 * Per-region sibling markers (epic #7). A logical app declares
 * `swarmy.region.<region>.replicas=<n>`; the region-reconcile worker materialises
 * one Docker service per region named `<name>-<region>` carrying these two labels,
 * so the canvas can group siblings back under their parent logical service.
 */
export const REGION_PARENT_LABEL = 'swarmy.region.parent';
export const REGION_OF_LABEL = 'swarmy.region.of';
export const UNGROUPED = '(ungrouped)';

/** Networks that never imply an application link. */
const SYSTEM_NETWORKS = new Set(['ingress', 'bridge', 'host', 'none', 'docker_gwbridge']);

export type InvServiceStatus = 'running' | 'degraded' | 'deploying' | 'idle' | 'stopped';

export interface InvContainer {
  id: string;
  name: string;
  image: string;
  state: string;
}
export interface InvService {
  id: string;
  name: string;
  image: string;
  /** Project = Docker stack namespace, or UNGROUPED. */
  stack: string;
  mode: 'replicated' | 'global';
  replicas: { desired: number; running: number };
  status: InvServiceStatus;
  /** True when labelled for scale-to-zero (idle = intentional, not failure). */
  scaleToZero: boolean;
  /**
   * When set, this service is a per-region sibling materialised by the
   * region-reconcile worker, and this is the parent logical service's name
   * (`swarmy.region.parent`). The canvas nests siblings under that parent.
   */
  regionParent?: string;
  /** When a sibling, the region (`swarmy.region` node-label value) it is pinned to. */
  region?: string;
  labels: Record<string, string>;
  networks: { name: string; aliases: string[] }[];
  env: string[];
  ports: { target: number; published?: number; protocol: string }[];
  /** Docker secret names the service spec references (usage map — never values).
   *  Optional (additive) — buildInventory always fills it; older/demo shapes may omit. */
  secrets?: string[];
  /** Docker config names the service spec references. Optional (additive). */
  configs?: string[];
  containers: InvContainer[];
}
export interface InvProject {
  name: string;
  serviceIds: string[];
}
export interface InvEdge {
  from: string;
  to: string;
  kind: 'network' | 'depends';
  label?: string;
}
export interface Inventory {
  projects: InvProject[];
  services: InvService[];
  edges: InvEdge[];
}

function statusOf(desired: number, running: number, scaleToZero: boolean): InvServiceStatus {
  if (desired === 0) return scaleToZero ? 'idle' : 'stopped';
  if (running >= desired) return 'running';
  if (running === 0) return 'deploying';
  return 'degraded';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildInventory(services: SwarmServiceInfo[], containers: ContainerInfo[]): Inventory {
  // Containers → service (swarm task carries the service id).
  const ctrsByService = new Map<string, InvContainer[]>();
  for (const c of containers) {
    const sid = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
    if (!sid) continue;
    const list = ctrsByService.get(sid) ?? [];
    list.push({ id: c.id, name: c.name, image: c.image, state: c.state });
    ctrsByService.set(sid, list);
  }

  const invServices: InvService[] = services.map((s) => {
    const desired = s.mode === 'global' ? Math.max(s.runningReplicas, 1) : (s.desiredReplicas ?? 0);
    const scaleToZero = s.labels?.[SCALE_TO_ZERO_LABEL] === 'true';
    return {
      id: s.id,
      name: s.name,
      image: s.image,
      stack: s.labels?.[STACK_LABEL] ?? UNGROUPED,
      mode: s.mode,
      replicas: { desired, running: s.runningReplicas },
      status: statusOf(desired, s.runningReplicas, scaleToZero),
      scaleToZero,
      regionParent: s.labels?.[REGION_PARENT_LABEL] || undefined,
      region: s.labels?.[REGION_OF_LABEL] || undefined,
      labels: s.labels ?? {},
      networks: s.networks ?? [],
      env: s.env ?? [],
      ports: s.ports ?? [],
      secrets: s.secrets ?? [],
      configs: s.configs ?? [],
      containers: ctrsByService.get(s.id) ?? [],
    };
  });

  // Projects = stack groups; ungrouped sorts last.
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const s of invServices) {
    if (!groups.has(s.stack)) {
      groups.set(s.stack, []);
      order.push(s.stack);
    }
    groups.get(s.stack)!.push(s.id);
  }
  order.sort((a, b) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));
  const projects: InvProject[] = order.map((name) => ({ name, serviceIds: groups.get(name)! }));

  const edges = inferEdges(invServices);
  return { projects, services: invServices, edges };
}

function inferEdges(services: InvService[]): InvEdge[] {
  const edges: InvEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: InvEdge['kind'], label?: string) => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind, label });
  };

  // Network edges (undirected → emit once per pair).
  const byNet = new Map<string, string[]>();
  for (const s of services) {
    for (const n of s.networks) {
      if (!n.name || SYSTEM_NETWORKS.has(n.name)) continue;
      (byNet.get(n.name) ?? byNet.set(n.name, []).get(n.name)!).push(s.id);
    }
  }
  for (const [net, ids] of byNet) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) add(ids[i]!, ids[j]!, 'network', net);
    }
  }

  // Env-ref edges (directed: referencer → referenced).
  const nameToId = new Map<string, string>();
  for (const s of services) {
    const names = new Set<string>([s.name.toLowerCase()]);
    if (s.stack !== UNGROUPED && s.name.startsWith(`${s.stack}_`)) {
      names.add(s.name.slice(s.stack.length + 1).toLowerCase());
    }
    for (const n of s.networks) for (const a of n.aliases) names.add(a.toLowerCase());
    for (const nm of names) if (nm.length >= 3) nameToId.set(nm, s.id);
  }
  for (const s of services) {
    for (const kv of s.env) {
      const eq = kv.indexOf('=');
      const key = eq >= 0 ? kv.slice(0, eq) : kv;
      const val = (eq >= 0 ? kv.slice(eq + 1) : '').toLowerCase();
      if (!val) continue;
      for (const [name, id] of nameToId) {
        if (id === s.id) continue;
        if (val === name || new RegExp(`(^|[^a-z0-9-])${escapeRe(name)}([^a-z0-9-]|$)`).test(val)) {
          add(s.id, id, 'depends', key);
        }
      }
    }
  }

  return edges;
}
