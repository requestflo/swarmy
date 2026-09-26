import type { ContainerInfo, SwarmServiceInfo } from './protocol';
import { explainImagePullError } from './pull-errors';

/**
 * Pure projection of live Docker state into the swarmy hierarchy + link graph.
 *
 * Docker is the source of truth: a "project" is a Docker **stack** (the native
 * `com.docker.stack.namespace` label); services without one fall into a single
 * "(ungrouped)" project. Edges are *inferred*, never declared:
 *   - network: two services sharing a non-system overlay network are linked.
 *   - depends: a service whose env references another service by a name it
 *     can resolve: the full service name, or a short name/alias on a network
 *     the two share that is not platform plumbing (never the `swarmy` overlay).
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

/**
 * swarmy's own platform plumbing (observability collector + ClickHouse, the
 * ingress Caddy controller, the Garage object store, …) deploys as one
 * managed Docker stack so it gets a coherent home in the stacks list/canvas
 * instead of floating as `UNGROUPED`. `SYSTEM_STACK` is the
 * `com.docker.stack.namespace` value every such service is stamped with;
 * `SYSTEM_STACK_LABEL` is an additional marker (value `'true'`) so the UI can
 * tell a system stack apart even if a service is (re)namespaced oddly. A
 * stack is "system" when its name is `SYSTEM_STACK` OR any of its services
 * carry `SYSTEM_STACK_LABEL`.
 */
export const SYSTEM_STACK = 'swarmy-system';
export const SYSTEM_STACK_LABEL = 'swarmy.system';

/**
 * The ONE shared, attachable overlay every swarmy platform service joins (the
 * Caddy edge, the OTel collector, the Garage object store, …) and that
 * one-shot sidecars attach to so in-cluster names like `swarmy-garage`
 * resolve. Canonical — every other "swarmy overlay" constant aliases this.
 */
export const SWARMY_OVERLAY_NETWORK = 'swarmy';

/** Marker `network.ensure`/compose deploys stamp on every object swarmy created. */
export const SWARMY_MANAGED_LABEL = 'swarmy.managed';

/**
 * True when a Docker network is one swarmy itself created for compose stack
 * `stack` (so removing the stack may remove it): labelled with the stack
 * namespace AND `swarmy.managed=true`. External networks carry neither label
 * (compose never creates them); the shared `swarmy` overlay and Docker's own
 * networks are refused outright regardless of labels.
 */
export function isSwarmyStackNetwork(
  net: { Name?: string; Labels?: Record<string, string> | null },
  stack: string,
): boolean {
  if (!stack || !net.Name) return false;
  if (net.Name === SWARMY_OVERLAY_NETWORK || SYSTEM_NETWORKS.has(net.Name)) return false;
  const labels = net.Labels ?? {};
  return labels[STACK_LABEL] === stack && labels[SWARMY_MANAGED_LABEL] === 'true';
}

/** True when `name` is the reserved swarmy-system stack namespace. */
export function isSystemStack(name: string): boolean {
  return name === SYSTEM_STACK;
}

/** Networks that never imply an application link. */
// `swarmy` / `swarmy-control` are platform plumbing: sharing them (every routed
// service meets the edge on `swarmy`) is not an application link.
const SYSTEM_NETWORKS = new Set([
  'ingress',
  'bridge',
  'host',
  'none',
  'docker_gwbridge',
  SWARMY_OVERLAY_NETWORK,
  'swarmy-control',
]);

/**
 * `failing` = wants replicas, has none running, and it is not converging: tasks
 * keep failing/being rejected (a crash loop, a bad image, an unplaceable
 * constraint), or nothing has come up long after the last spec update. Distinct
 * from `deploying` so a crash loop never reads as "still converging" forever.
 */
export type InvServiceStatus = 'running' | 'degraded' | 'deploying' | 'failing' | 'idle' | 'stopped';

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
  /** Most recent task error (`docker service ps` ERROR column), when the agent
   *  reported one — the "why" behind a `failing`/`degraded` status. */
  lastError?: string;
  /** When `lastError` was observed (ms since epoch). */
  lastErrorAt?: number;
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

/** Failed/rejected tasks in the recent window that mark a crash loop. */
export const FAILING_MIN_FAILURES = 2;
/** No replica running this long after the last spec update ⇒ not converging. */
export const FAILING_AFTER_MS = 2 * 60_000;
/** Task-failure lookback window the agent counts `recentFailures` over. */
export const TASK_FAILURE_WINDOW_MS = 10 * 60_000;

export type TaskHealth = NonNullable<SwarmServiceInfo['taskHealth']>;

export interface StatusSignals {
  /** Task-history health from the agent (absent from older agents). */
  taskHealth?: SwarmServiceInfo['taskHealth'];
  /** Service spec `UpdatedAt` (ms). */
  updatedAt?: number;
  /** Clock (ms); injectable for tests. */
  now?: number;
}

export function statusOf(
  desired: number,
  running: number,
  scaleToZero: boolean,
  signals: StatusSignals = {},
): InvServiceStatus {
  if (desired === 0) return scaleToZero ? 'idle' : 'stopped';
  if (running >= desired) return 'running';
  if (running > 0) return 'degraded';
  const th = signals.taskHealth;
  // Repeated failed/rejected tasks = a crash loop, however recent the update.
  if (th && th.recentFailures >= FAILING_MIN_FAILURES) return 'failing';
  // Nothing up long after the last update, and nothing mid-start (a slow image
  // pull reports `preparing`, which keeps it `deploying`).
  const now = signals.now ?? Date.now();
  if (signals.updatedAt && now - signals.updatedAt > FAILING_AFTER_MS && !th?.starting) return 'failing';
  return 'deploying';
}

/** A swarm task, as far as task-health summarising cares (dockerode-loose). */
export interface TaskLike {
  DesiredState?: string;
  Status?: {
    State?: string;
    Timestamp?: string;
    Err?: string;
    Message?: string;
    ContainerStatus?: { ExitCode?: number };
  };
}

const STARTING_STATES = new Set(['new', 'allocated', 'assigned', 'accepted', 'preparing', 'ready', 'starting']);

/**
 * Summarise a service's task history (all tasks incl. shut-down ones, as
 * `docker service ps` shows them) into the wire `taskHealth`. Pure.
 */
export function summarizeTasks(tasks: TaskLike[], now: number = Date.now()): TaskHealth {
  let recentFailures = 0;
  let lastError: string | undefined;
  let lastErrorAt: number | undefined;
  let starting = false;
  for (const t of tasks) {
    const state = t.Status?.State ?? '';
    const at = Date.parse(t.Status?.Timestamp ?? '') || 0;
    if (t.DesiredState === 'running' && STARTING_STATES.has(state) && !t.Status?.Err) starting = true;
    const failed = state === 'failed' || state === 'rejected';
    if (failed && (!at || now - at <= TASK_FAILURE_WINDOW_MS)) recentFailures++;
    const exit = t.Status?.ContainerStatus?.ExitCode;
    const err =
      t.Status?.Err ||
      (failed ? t.Status?.Message || (exit ? `exit code ${exit}` : state) : undefined);
    if (err && (lastErrorAt === undefined || at > lastErrorAt)) {
      lastError = err;
      lastErrorAt = at;
    }
  }
  return {
    recentFailures,
    ...(lastError ? { lastError } : {}),
    ...(lastError && lastErrorAt ? { lastErrorAt } : {}),
    starting,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildInventory(
  services: SwarmServiceInfo[],
  containers: ContainerInfo[],
  now: number = Date.now(),
): Inventory {
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
      status: statusOf(desired, s.runningReplicas, scaleToZero, { taskHealth: s.taskHealth, updatedAt: s.updatedAt, now }),
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
      // A Hub rate limit / cache 5xx names its cause and fix (pull-errors).
      ...(s.taskHealth?.lastError ? { lastError: explainImagePullError(s.taskHealth.lastError) } : {}),
      ...(s.taskHealth?.lastErrorAt ? { lastErrorAt: s.taskHealth.lastErrorAt } : {}),
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

  // Env-ref edges (directed: referencer → referenced). A name only counts
  // where Docker would actually resolve it for the referencer:
  //   - a full service name (`stack_svc`) — unique, deliberate wiring;
  //   - a short name or alias only on a network the two share that is not
  //     platform plumbing. Every routed app sits on the `swarmy` overlay with
  //     its short name as an alias, so matching those would link unrelated
  //     apps ("api" in one app's URL is not another stack's `api`).
  const fullName = new Map<string, string>();
  const aliasOn = new Map<string, Map<string, string[]>>(); // network → name → ids
  for (const t of services) {
    if (t.name.length >= 3) fullName.set(t.name.toLowerCase(), t.id);
    const short = t.stack !== UNGROUPED && t.name.startsWith(`${t.stack}_`) ? t.name.slice(t.stack.length + 1).toLowerCase() : null;
    for (const n of t.networks) {
      if (!n.name || SYSTEM_NETWORKS.has(n.name)) continue;
      const names = aliasOn.get(n.name) ?? aliasOn.set(n.name, new Map()).get(n.name)!;
      for (const nm of new Set([...(short ? [short] : []), ...n.aliases.map((x) => x.toLowerCase())])) {
        if (nm.length >= 3) (names.get(nm) ?? names.set(nm, []).get(nm)!).push(t.id);
      }
    }
  }
  const mentions = (val: string, name: string) =>
    val === name || new RegExp(`(^|[^a-z0-9-])${escapeRe(name)}([^a-z0-9-]|$)`).test(val);
  for (const s of services) {
    const reachable = new Map<string, Set<string>>([...fullName].map(([nm, id]) => [nm, new Set([id])]));
    for (const n of s.networks) {
      if (!n.name || SYSTEM_NETWORKS.has(n.name)) continue;
      for (const [nm, ids] of aliasOn.get(n.name) ?? []) {
        const set = reachable.get(nm) ?? reachable.set(nm, new Set()).get(nm)!;
        for (const id of ids) set.add(id);
      }
    }
    for (const kv of s.env) {
      const eq = kv.indexOf('=');
      const key = eq >= 0 ? kv.slice(0, eq) : kv;
      const val = (eq >= 0 ? kv.slice(eq + 1) : '').toLowerCase();
      if (!val) continue;
      for (const [name, ids] of reachable) {
        if (!mentions(val, name)) continue;
        for (const id of ids) if (id !== s.id) add(s.id, id, 'depends', key);
      }
    }
  }

  return edges;
}
