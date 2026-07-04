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
 * Deploy/converge a NATIVE Caddy ingress controller on the swarm and keep its
 * admin API reachable so the agent's `applyIngress` admin-API path (POST the
 * rendered Caddyfile to `/load`) lands inside the controller instead of on the
 * agent host.
 *
 * The controller is a single managed swarm service:
 *   - `swarmy-ingress-caddy` running `caddy:2-alpine`
 *   - admin API on 0.0.0.0:2019, ports 80/443 published (Swarm routing mesh)
 *   - attached to the org's ingress overlay network (default `swarmy`)
 *   - started with `caddy run --resume` over a base Caddyfile that enables the
 *     admin endpoint — so first boot binds admin on the overlay, and after a
 *     `/load` the autosaved live config (which also carries `admin 0.0.0.0:2019`,
 *     see the renderer) is what `--resume` restores on restart.
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
  /** Replica count. Default 1 (Swarm's routing mesh fans 80/443 in from any node). */
  replicas?: number;
  /** Also publish the admin API on the host (handy for `curl localhost:2019/config/`). Default true. */
  publishAdmin?: boolean;
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

type ResolvedOptions = Required<Omit<EnsureControllerOptions, 'otelOrgId'>> & {
  otelOrgId?: string;
};

/** Swarm node-role label that marks a node as an ingress (edge) node. */
const INGRESS_NODE_LABEL = 'swarmy.node.ingress';

/**
 * Placement constraint for the ingress controller.
 *
 * 1. An explicit single target node (`targetNodes` settings, one id) pins the
 *    container there directly — the common "run it on this exact box" case.
 *    Swarm constraints AND together, so a *list* of ids can't express "any of
 *    these" via `node.id==`; multi-node targeting still goes through step 2.
 * 2. Otherwise prefer nodes explicitly marked `swarmy.node.ingress=true` (the
 *    edge tier, toggled per-node from Settings → Nodes).
 * 3. Fall back to managers when nothing is marked yet, so a fresh swarm still
 *    schedules the controller.
 */
function ingressPlacementConstraint(ctx: OrgContext, targetNodes: string[] = []): string {
  if (targetNodes.length === 1) return `node.id==${targetNodes[0]}`;
  const marked = ctx.hub
    .nodeInventory(ctx.activeOrgId, true)
    .some((n) => n.labels[INGRESS_NODE_LABEL] === 'true');
  return marked ? `node.labels.${INGRESS_NODE_LABEL}==true` : 'node.role == manager';
}

function controllerSpec(opts: ResolvedOptions, placementConstraint: string): ServiceSpec {
  const ports: NonNullable<ServiceSpec['ports']> = [
    { target: 80, published: 80, protocol: 'tcp', mode: 'ingress' },
    { target: 443, published: 443, protocol: 'tcp', mode: 'ingress' },
  ];
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
      `printf '{\\n\\tadmin 0.0.0.0:${CADDY_ADMIN_PORT}\\n}\\n' > ${CADDY_CONFIG_PATH} && ` +
        `exec caddy run --config ${CADDY_CONFIG_PATH} --adapter caddyfile`,
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
    publishAdmin: options.publishAdmin ?? true,
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
      spec: controllerSpec(opts, ingressPlacementConstraint(ctx, opts.targetNodes)),
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
