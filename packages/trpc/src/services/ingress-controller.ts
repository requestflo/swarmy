import { STACK_LABEL, SYSTEM_STACK, SYSTEM_STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import {
  CADDY_ADMIN_PORT,
  CADDY_CONFIG_PATH,
  CADDY_CONTROLLER_SERVICE,
  CADDY_EDGE_HOST_DIR,
  CADDY_EDGE_SERVICE,
} from '@swarmy/ingress';
import type { OrgContext } from '../context';
import type { CommandName } from '../hub/types';
import { mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { liveService } from './service.service';

// `network.ensure` becomes a valid CommandName once the hub/types.ts integration
// snippet lands; the cast keeps @swarmy/trpc green until then (see INTEGRATION).
const NETWORK_ENSURE = 'network.ensure' as CommandName;

/**
 * Deploy/converge a NATIVE Caddy ingress controller on the swarm (the default
 * `controller` topology). Routes reach it by the agent on the node hosting the
 * task writing the rendered Caddyfile into the task and exec'ing `caddy reload`
 * (`applyVia: 'exec'` — see `ingress.service` `makeDispatch`), so neither the
 * agent's network membership nor a published admin API matter.
 *
 * The controller is a single managed swarm service:
 *   - `swarmy-ingress-caddy` running `caddy:2-alpine`
 *   - ports 80/443 published in HOST mode on the node the task lands on
 *   - attached to the org's ingress overlay network (default `swarmy`)
 *   - started with `--resume` so the autosaved last-applied config survives a
 *     task restart; first boot writes a base Caddyfile (admin bound for the
 *     opt-in `applyVia: 'admin'` path, overlay-only unless `publishAdmin`).
 *
 * Idempotent: `service.deploy` is create+update, so re-running converges the
 * running service to this spec.
 */

const DEFAULT_NETWORK = 'swarmy';
const DEFAULT_IMAGE = 'caddy:2-alpine';
const DATA_VOLUME = 'swarmy-ingress-caddy-data';
const CONFIG_VOLUME = 'swarmy-ingress-caddy-config';

export interface EnsureControllerOptions {
  /** Overlay network the controller attaches to (must match the app services it fronts). Default `swarmy`. */
  network?: string;
  /** Controller image. Default `caddy:2-alpine`. */
  image?: string;
  /** Replica count. Default 1 (80/443 are host-mode on the node the task lands on). */
  replicas?: number;
  /**
   * Also publish the admin API on the host (handy for `curl localhost:2019/config/`).
   * Default FALSE: config is delivered by in-task exec, and Caddy's admin API
   * is unauthenticated — publishing it lets anyone who can reach the node
   * rewrite the edge.
   */
  publishAdmin?: boolean;
  /**
   * Bind the admin API on the overlay (`0.0.0.0`) so the controller can `/load`
   * it by service name — only the opt-in `applyVia: 'admin'` path needs this.
   * Default FALSE: admin stays on loopback, reachable only by the in-task
   * `caddy reload` the exec path uses.
   */
  adminOnOverlay?: boolean;
  /** Preferred target node ids (`IngressConfigView.targetNodes`) — see `ingressPlacementConstraint`. */
  targetNodes?: string[];
  /**
   * When set, the controller runs with OTLP exporter env so Caddy's `tracing`
   * directive ships edge spans to the observability collector. The value is the
   * org id (stamped as the `swarmy.org_id` resource attribute the traces query
   * scopes on). Unset ⇒ no telemetry env (observability off).
   */
  otelOrgId?: string;
}

export interface EnsureControllerResult {
  /** Live Docker service id (falls back to the service name until inventory catches up). */
  id: string;
  name: string;
  network: string;
  /** Admin `/load` URL the driver should target (set `extraConfig.adminUrl` to this on the org config). */
  adminUrl: string;
}

export type ResolvedOptions = Required<Omit<EnsureControllerOptions, 'otelOrgId'>> & {
  otelOrgId?: string;
};

/** Swarm node-role label that marks a node as an ingress (edge) node. */
const INGRESS_NODE_LABEL = 'swarmy.node.ingress';

/** Inputs for {@link ingressPlacementConstraint} — pure data, no hub. */
export interface PlacementInput {
  /** `IngressConfigView.targetNodes` — swarmy ENROLLMENT node ids (DB `Node.id`). */
  targetNodes: string[];
  /** Enrollment id → Docker Swarm node id (`hub.swarmNodeIdFor`). */
  swarmNodeIdFor: (enrollmentId: string) => string | undefined;
  /** Docker Swarm node ids known for the org (legacy pins may already be swarm ids). */
  knownSwarmNodeIds: ReadonlySet<string>;
  /** Whether any node carries `swarmy.node.ingress=true`. */
  anyIngressLabelled: boolean;
}

/**
 * Placement constraint for the ingress controller. Pure.
 *
 * 1. An explicit single target node pins the controller there via
 *    `node.id==<DOCKER SWARM node id>`. The pin is stored as swarmy's own
 *    enrollment id (the Target-nodes UI sends `Node.id`, a cuid Docker has
 *    never heard of), so it MUST be translated through `swarmNodeIdFor` — the
 *    same bridge `dispatchNodeLabels` uses. Emitting the raw enrollment id made
 *    the controller permanently unschedulable ("no suitable node").
 *    A pin that cannot be resolved (node never reported, stale id) falls
 *    through to step 2 rather than emitting an unsatisfiable constraint.
 *    Swarm constraints AND together, so a *list* of ids can't express "any of
 *    these" via `node.id==`; multi-node targeting goes through step 2.
 * 2. Otherwise prefer nodes explicitly marked `swarmy.node.ingress=true` (the
 *    edge tier, toggled per-node from Settings → Nodes / Target nodes).
 * 3. Fall back to managers when nothing is marked yet, so a fresh swarm still
 *    schedules the controller.
 */
export function ingressPlacementConstraint(input: PlacementInput): string {
  if (input.targetNodes.length === 1) {
    const pin = input.targetNodes[0]!;
    const swarmId =
      input.swarmNodeIdFor(pin) ?? (input.knownSwarmNodeIds.has(pin) ? pin : undefined);
    if (swarmId) return `node.id==${swarmId}`;
  }
  return input.anyIngressLabelled
    ? `node.labels.${INGRESS_NODE_LABEL}==true`
    : 'node.role == manager';
}

/** Resolve {@link PlacementInput} off the live hub for the ctx org. */
function placementFor(ctx: OrgContext, targetNodes: string[] = []): string {
  const inventory = ctx.hub.nodeInventory(ctx.activeOrgId, true);
  return ingressPlacementConstraint({
    targetNodes,
    swarmNodeIdFor: (id) => ctx.hub.swarmNodeIdFor(id),
    knownSwarmNodeIds: new Set(inventory.map((n) => n.swarmNodeId)),
    anyIngressLabelled: inventory.some((n) => n.labels[INGRESS_NODE_LABEL] === 'true'),
  });
}

/**
 * The replicated controller ServiceSpec. Pure — exported for the golden test.
 *
 * - 80/443 publish in HOST mode on the node the (single) task lands on. The
 *   routing mesh is not relied on: it is unreachable on some hosts (Lima VMs,
 *   locked-down kernels) and re-balances away from the node DNS points at; host
 *   mode also preserves client IPs for the edge. Same rule as the edge plane.
 * - The admin API is NOT published by default: routes are delivered by the
 *   agent exec'ing into the task (`applyVia: 'exec'`), so an unauthenticated
 *   admin endpoint never needs to face the network.
 * - `--resume` restores the last applied config (autosaved on the config
 *   volume) across task restarts, so a restart doesn't drop every route until
 *   the next reconcile tick.
 */
export function caddyControllerSpec(
  opts: ResolvedOptions,
  placementConstraint: string,
): ServiceSpec {
  const ports: NonNullable<ServiceSpec['ports']> = [
    { target: 80, published: 80, protocol: 'tcp', mode: 'host' },
    { target: 443, published: 443, protocol: 'tcp', mode: 'host' },
  ];
  // Caddy's admin API is unauthenticated: never bind it beyond loopback unless
  // something off-task genuinely has to reach it.
  const adminHost = opts.publishAdmin || opts.adminOnOverlay ? '0.0.0.0' : '127.0.0.1';
  if (opts.publishAdmin) {
    ports.push({ target: CADDY_ADMIN_PORT, published: CADDY_ADMIN_PORT, protocol: 'tcp', mode: 'ingress' });
  }
  // OTLP exporter env for Caddy's `tracing` directive. Caddy reads standard
  // OTEL_* vars; org id lands as the `swarmy.org_id` resource attribute the
  // traces query scopes on. The controller already joins the `swarmy` overlay,
  // so `swarmy-otel-collector` resolves. Only set when observability is on.
  // Collector service name + OTLP gRPC port (mirrors observability-stack.ts —
  // kept local to avoid coupling the ingress controller to the observability module).
  const OTEL_COLLECTOR_HOST = 'swarmy-otel-collector';
  const OTEL_COLLECTOR_GRPC_PORT = 4317;
  const env = opts.otelOrgId
    ? {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${OTEL_COLLECTOR_HOST}:${OTEL_COLLECTOR_GRPC_PORT}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_SERVICE_NAME: CADDY_CONTROLLER_SERVICE,
        OTEL_RESOURCE_ATTRIBUTES: `swarmy.org_id=${opts.otelOrgId}`,
        OTEL_TRACES_SAMPLER: 'parentbased_always_on',
      }
    : undefined;
  return {
    name: CADDY_CONTROLLER_SERVICE,
    image: opts.image,
    mode: { replicated: { replicas: opts.replicas } },
    labels: {
      'swarmy.managed': 'true',
      'swarmy.role': 'ingress',
      // Group under the swarmy-system stack namespace (platform plumbing, not
      // a user app stack) and mark it so the UI can tell system stacks apart.
      [STACK_LABEL]: SYSTEM_STACK,
      [SYSTEM_STACK_LABEL]: 'true',
    },
    ...(env ? { env } : {}),
    // The container writes its own admin-enabling base config on boot (no host bind
    // mount / root needed), then swarmy pushes the rendered routes to the admin API.
    command: [
      'sh',
      '-c',
      `printf '{\\n\\tadmin ${adminHost}:${CADDY_ADMIN_PORT}\\n}\\n' > ${CADDY_CONFIG_PATH} && ` +
        `exec caddy run --config ${CADDY_CONFIG_PATH} --adapter caddyfile --resume`,
    ],
    ports,
    mounts: [
      { type: 'volume', source: DATA_VOLUME, target: '/data' },
      { type: 'volume', source: CONFIG_VOLUME, target: '/config' },
    ],
    networks: [opts.network],
    placement: { constraints: [placementConstraint] },
  };
}

export async function ensureCaddyController(
  ctx: OrgContext,
  options: EnsureControllerOptions = {},
): Promise<EnsureControllerResult> {
  // Observability on ⇒ the controller runs with OTLP exporter env so Caddy's
  // tracing directive can ship edge spans. Direct DB read (no coupling to the
  // observability module); caller may override via options.otelOrgId.
  let otelOrgId = options.otelOrgId;
  if (otelOrgId === undefined) {
    const obs = await ctx.db.observabilityConfig.findUnique({
      where: { orgId: ctx.activeOrgId },
      select: { enabled: true },
    });
    if (obs?.enabled) otelOrgId = ctx.activeOrgId;
  }
  const opts: ResolvedOptions = {
    network: options.network ?? DEFAULT_NETWORK,
    image: options.image ?? DEFAULT_IMAGE,
    replicas: options.replicas ?? 1,
    publishAdmin: options.publishAdmin ?? false,
    adminOnOverlay: options.adminOnOverlay ?? false,
    targetNodes: options.targetNodes ?? [],
    otelOrgId,
  };
  const node = await resolveManagerNode(ctx);

  // Ensure the ingress overlay exists BEFORE the controller deploy so attaching
  // to a freshly-named network doesn't fail with "network <x> not found".
  try {
    await ctx.hub.dispatch(node.id, NETWORK_ENSURE, {
      name: opts.network,
      driver: 'overlay',
      attachable: true,
      labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress' },
    });
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Deploy/converge the controller service (create+update idempotent). The container
  // writes its own admin-enabling base config on boot (no host bind mount / root), then
  // swarmy pushes the rendered routes to its admin API on every apply.
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', {
      spec: caddyControllerSpec(opts, placementFor(ctx, opts.targetNodes)),
      pullPolicy: 'missing',
    });
  } catch (e) {
    throw mapDispatchError(e);
  }

  const id = liveService(ctx, CADDY_CONTROLLER_SERVICE)?.id ?? CADDY_CONTROLLER_SERVICE;
  return {
    id,
    name: CADDY_CONTROLLER_SERVICE,
    network: opts.network,
    adminUrl: `http://${CADDY_CONTROLLER_SERVICE}:${CADDY_ADMIN_PORT}/load`,
  };
}


// ───────────────────────────────────────────── edge-per-node topology (geo-edge) ──

export interface EnsureEdgeOptions {
  /** Overlay network the edge attaches to (must match fronted services). Default `swarmy`. */
  network?: string;
  /**
   * Edge image. Default docker/caddy-swarmy (ghcr) — the swarmy build with
   * caddy-ratelimit AND caddy-storage-redis compiled in; distributed cert
   * storage requires it, so stock caddy:2-alpine is rejected by validate().
   */
  image?: string;
  otelOrgId?: string;
}

const DEFAULT_EDGE_IMAGE =
  process.env.SWARMY_CADDY_EDGE_IMAGE ?? 'ghcr.io/requestflo/caddy-swarmy:2';

/**
 * The edge Caddy ServiceSpec — THE single-sourced contract (geo-edge skill):
 * the swarmy-stack composition must consume this builder, never hand-roll,
 * so topology/ports/mounts stay in one place.
 *
 * Shape (each choice is load-bearing):
 * - GLOBAL mode constrained to `swarmy.node.ingress==true` — one task per edge
 *   node, converging automatically as nodes are labeled.
 * - HOST-MODE 80/443 — the routing mesh would re-balance connections away from
 *   the node geo-DNS just chose; host mode terminates on THAT node.
 * - NO admin port published — config arrives per node via the agent's
 *   `localReload` exec path (applyVia 'local').
 * - `/var/lib/swarmy/ingress` (host, agent-written) bind-mounted RO at
 *   /etc/caddy — the agent must have this path host-mounted rw.
 */
export function caddyEdgeSpec(opts: {
  network: string;
  image: string;
  otelOrgId?: string;
}): ServiceSpec {
  const env = opts.otelOrgId
    ? {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://swarmy-otel-collector:4317',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_SERVICE_NAME: CADDY_EDGE_SERVICE,
        OTEL_RESOURCE_ATTRIBUTES: `swarmy.org_id=${opts.otelOrgId}`,
        OTEL_TRACES_SAMPLER: 'parentbased_always_on',
      }
    : undefined;
  return {
    name: CADDY_EDGE_SERVICE,
    image: opts.image,
    mode: { global: {} },
    labels: {
      'swarmy.managed': 'true',
      'swarmy.role': 'ingress',
      'swarmy.ingress.topology': 'edge-per-node',
      [STACK_LABEL]: SYSTEM_STACK,
      [SYSTEM_STACK_LABEL]: 'true',
    },
    ...(env ? { env } : {}),
    // Boot against the agent-written host config when present; fall back to a
    // minimal empty config so the task starts on a node the agent hasn't
    // rendered yet (first apply lands seconds later via localReload).
    command: [
      'sh',
      '-c',
      `[ -f ${CADDY_CONFIG_PATH} ] || printf '# swarmy edge — awaiting first render\n' > /tmp/empty.caddyfile; ` +
        `exec caddy run --config ${CADDY_CONFIG_PATH} --adapter caddyfile 2>/dev/null || ` +
        `exec caddy run --config /tmp/empty.caddyfile --adapter caddyfile`,
    ],
    ports: [
      { target: 80, published: 80, protocol: 'tcp', mode: 'host' },
      { target: 443, published: 443, protocol: 'tcp', mode: 'host' },
      { target: 443, published: 443, protocol: 'udp', mode: 'host' }, // HTTP/3
    ],
    mounts: [
      { type: 'volume', source: DATA_VOLUME, target: '/data' },
      { type: 'volume', source: CONFIG_VOLUME, target: '/config' },
      { type: 'bind', source: CADDY_EDGE_HOST_DIR, target: '/etc/caddy', readOnly: true },
    ],
    networks: [opts.network],
    placement: { constraints: ['node.labels.swarmy.node.ingress == true'] },
    restartPolicy: { condition: 'any' },
  };
}

export interface EnsureEdgeResult {
  id: string;
  name: string;
  network: string;
  /** True when a legacy replicated/routing-mesh controller was cut over. */
  migrated: boolean;
}

/**
 * Deploy/converge the edge-per-node Caddy (geo-edge). Handles the LEGACY
 * cutover: Docker cannot change a service's mode in place and routing-mesh
 * 80/443 binds on every node, so a replicated controller must be REMOVED
 * before the global host-mode service deploys (seconds of blip — gated behind
 * the explicit topology switch; same service name keeps the cert volumes).
 */
export async function ensureCaddyEdge(
  ctx: OrgContext,
  options: EnsureEdgeOptions = {},
): Promise<EnsureEdgeResult> {
  let otelOrgId = options.otelOrgId;
  if (otelOrgId === undefined) {
    const obs = await ctx.db.observabilityConfig.findUnique({
      where: { orgId: ctx.activeOrgId },
      select: { enabled: true },
    });
    if (obs?.enabled) otelOrgId = ctx.activeOrgId;
  }
  const network = options.network ?? DEFAULT_NETWORK;
  const image = options.image ?? DEFAULT_EDGE_IMAGE;
  const node = await resolveManagerNode(ctx);

  try {
    await ctx.hub.dispatch(node.id, NETWORK_ENSURE, {
      name: network,
      driver: 'overlay',
      attachable: true,
      labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress' },
    });
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Legacy cutover: a live service WITHOUT the edge topology label is the old
  // replicated controller — remove it first (mode is immutable in place).
  let migrated = false;
  const live = liveService(ctx, CADDY_EDGE_SERVICE);
  if (live && live.labels?.['swarmy.ingress.topology'] !== 'edge-per-node') {
    migrated = true;
    await ctx.hub
      .dispatch(node.id, 'service.remove', { name: CADDY_EDGE_SERVICE })
      .catch(() => undefined);
  }

  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', {
      spec: caddyEdgeSpec({ network, image, otelOrgId }),
      pullPolicy: 'missing',
    });
  } catch (e) {
    throw mapDispatchError(e);
  }

  const id = liveService(ctx, CADDY_EDGE_SERVICE)?.id ?? CADDY_EDGE_SERVICE;
  return { id, name: CADDY_EDGE_SERVICE, network, migrated };
}

// ─────────────────────────────────────────────── runtime truth (status badges) ──

/** Docker's per-task service-name label (set on every swarm task container). */
const SWARM_SERVICE_NAME_LABEL = 'com.docker.swarm.service.name';

/**
 * Enrollment ids of the org's connected nodes that host a RUNNING task of the
 * Caddy ingress service — Docker truth off each agent's container snapshot.
 * These are the only nodes an in-task apply (`applyVia: 'exec'`) can land on.
 */
export async function ingressTaskNodes(ctx: OrgContext): Promise<string[]> {
  return [...new Set((await ingressTasks(ctx)).map((t) => t.nodeId))];
}

/**
 * Every running Caddy ingress task container across the org's connected nodes
 * (`{nodeId, containerId}`, sorted). The container ids change whenever a task
 * is (re)scheduled — the reconcile signature keys on them so a fresh task
 * gets the config pushed without waiting for a route change.
 */
export async function ingressTasks(
  ctx: OrgContext,
): Promise<Array<{ nodeId: string; containerId: string }>> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const out: Array<{ nodeId: string; containerId: string }> = [];
  for (const { id } of nodes) {
    if (!ctx.hub.isOnline(id)) continue;
    for (const c of ctx.hub.latestContainers(id)) {
      if (c.state === 'running' && c.labels[SWARM_SERVICE_NAME_LABEL] === CADDY_CONTROLLER_SERVICE) {
        out.push({ nodeId: id, containerId: c.id });
      }
    }
  }
  return out.sort((a, b) =>
    a.nodeId === b.nodeId ? a.containerId.localeCompare(b.containerId) : a.nodeId.localeCompare(b.nodeId),
  );
}

/**
 * The edge's REAL state, as opposed to its saved config:
 * - `tracking`   driver `none` — swarmy writes no routing; nothing is served by swarmy
 * - `paused`     a driver is chosen but ingress is disabled
 * - `unverified` a bring-your-own driver (traefik/nginx/haproxy/cloudflared):
 *                swarmy wrote the config but cannot observe the proxy serving it
 * - `down`       swarmy's Caddy is not deployed, or has zero running tasks
 * - `deploying`  Caddy is deployed and converging (desired > running > 0 not yet / no apply yet)
 * - `degraded`   Caddy is running but the last config apply failed
 * - `serving`    Caddy has running task(s) AND the current config was applied to them
 */
export type EdgeRuntimeState =
  | 'tracking'
  | 'paused'
  | 'unverified'
  | 'down'
  | 'deploying'
  | 'degraded'
  | 'serving';

export interface EdgeApplyRecord {
  ok: boolean;
  at: string;
  message: string;
}

export interface EdgeRuntimeInput {
  driver: string;
  enabled: boolean;
  /** The swarmy Caddy service off live inventory (undefined = not deployed). */
  service?: {
    runningReplicas: number;
    desiredReplicas?: number;
    mode: 'replicated' | 'global';
    /** Last spec change (ms epoch) — a service with 0 tasks inside the grace window is still starting. */
    updatedAt?: number;
  };
  /** Hostnames of nodes with a running task (for the message). */
  taskHosts: string[];
  /** Outcome of the most recent render+apply for this org (in-process record). */
  lastApply?: EdgeApplyRecord;
  /** Clock (ms epoch) — injected so the derivation stays pure. */
  now: number;
}

/** A freshly (re)deployed service gets this long to pull + schedule before 0 tasks reads as `down`. */
export const EDGE_START_GRACE_MS = 3 * 60_000;

export interface EdgeRuntimeStatus {
  state: EdgeRuntimeState;
  /** True only when routes are actually being served by a swarmy-run proxy. */
  serving: boolean;
  message: string;
  runningTasks: number;
  desiredTasks: number | null;
  lastApply: EdgeApplyRecord | null;
}

/** Pure: derive the runtime edge status from Docker truth + the last apply. */
export function deriveEdgeRuntime(input: EdgeRuntimeInput): EdgeRuntimeStatus {
  const running = input.service?.runningReplicas ?? 0;
  const desired =
    input.service?.mode === 'replicated' ? (input.service.desiredReplicas ?? null) : null;
  const base = { runningTasks: running, desiredTasks: desired, lastApply: input.lastApply ?? null };
  const out = (state: EdgeRuntimeState, message: string): EdgeRuntimeStatus => ({
    ...base,
    state,
    serving: state === 'serving',
    message,
  });

  if (input.driver === 'none') {
    return out('tracking', 'Tracking only — swarmy writes no routing config, so no route is served.');
  }
  if (!input.enabled) return out('paused', 'Ingress is disabled — no route is served.');
  if (input.driver !== 'caddy') {
    if (input.lastApply && !input.lastApply.ok) {
      return out('degraded', `Last apply failed: ${input.lastApply.message}`);
    }
    return out(
      'unverified',
      'Routing config is written for a proxy swarmy does not run — reachability is not verified.',
    );
  }
  const failure = input.lastApply && !input.lastApply.ok ? ` Last error: ${input.lastApply.message}` : '';
  if (!input.service) {
    return out(
      'down',
      `The Caddy ingress controller is not deployed — nothing is listening on 80/443.${failure}`,
    );
  }
  if (running === 0) {
    const since = input.service.updatedAt;
    if (since !== undefined && Number.isFinite(since) && input.now - since < EDGE_START_GRACE_MS) {
      return out('deploying', 'The Caddy ingress controller is starting (pulling image / scheduling).');
    }
    return out(
      'down',
      'The Caddy ingress controller has no running task — nothing is listening on 80/443. ' +
        `Check its placement (\`docker service ps ${CADDY_CONTROLLER_SERVICE}\`) and image pull.${failure}`,
    );
  }
  if (input.lastApply && !input.lastApply.ok) {
    return out('degraded', `Caddy is up, but the last config apply failed: ${input.lastApply.message}`);
  }
  if (!input.lastApply) {
    return out('deploying', 'Caddy is up; waiting for the first config apply.');
  }
  const where = input.taskHosts.length ? ` on ${input.taskHosts.join(', ')}` : '';
  return out('serving', `Caddy is serving${where} (80/443).`);
}
