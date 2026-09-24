import {
  STACK_LABEL,
  SWARMY_CONTROL_NETWORK,
  SYSTEM_STACK,
  SYSTEM_STACK_LABEL,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import {
  CADDY_ADMIN_PORT,
  CADDY_CONFIG_PATH,
  CADDY_CONTROLLER_SERVICE,
  CADDY_EDGE_SERVICE,
  SWARMY_CADDY_IMAGE,
} from '@swarmy/ingress';
import { edgeCertsServiceWiring } from './ingress-certs';
import type { OrgContext } from '../context';
import type { CommandName } from '../hub/types';
import { mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { liveService } from './service.service';
import { ensureControlNetwork } from './platform-networks';
import { observabilityConfigRepo } from './observability-config.repo';
import { bucketAccessRepo } from './storage-cluster.repo';

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
 *   - `swarmy-ingress-caddy` running swarmy's Caddy build (`ghcr.io/requestflo/caddy-swarmy`)
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
/**
 * swarmy's Caddy build for BOTH topologies (docker/caddy-swarmy, public GHCR):
 * the plugins behind rate limits, response caching, country rules and the
 * shared `storage s3` cert store are compiled in, so no protection or topology
 * needs an image change first. Override: `setControllerImage` (per org) or
 * `SWARMY_CADDY_EDGE_IMAGE` (per controller).
 */
const DEFAULT_IMAGE = SWARMY_CADDY_IMAGE;
const DATA_VOLUME = 'swarmy-ingress-caddy-data';
const CONFIG_VOLUME = 'swarmy-ingress-caddy-config';

export interface EnsureControllerOptions {
  /** Overlay network the controller attaches to (must match the app services it fronts). Default `swarmy`. */
  network?: string;
  /** Controller image. Default {@link defaultEdgeImage} (swarmy's Caddy build). */
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
  /** ACME DNS-01 token secrets (acme-dns.service `acmeDnsServiceSecrets`) — wildcard certs. */
  acmeDnsSecrets?: EdgeSecretMount[];
}

/** A Docker secret mounted into a swarmy Caddy task. */
export interface EdgeSecretMount {
  source: string;
  target: string;
  mode: number;
}

export interface EnsureControllerResult {
  /** Live Docker service id (falls back to the service name until inventory catches up). */
  id: string;
  name: string;
  network: string;
  /** Admin `/load` URL the driver should target (set `extraConfig.adminUrl` to this on the org config). */
  adminUrl: string;
}

export type ResolvedOptions = Required<Omit<EnsureControllerOptions, 'otelOrgId' | 'acmeDnsSecrets'>> & {
  otelOrgId?: string;
  acmeDnsSecrets?: EdgeSecretMount[];
  /** Publish the mesh-peer object-storage listener (see {@link objectStorageMeshPort}). */
  objectStorageMeshPort?: number;
};

/** Where mesh peers reach swarmy object storage on an edge node (plain HTTP over WireGuard). */
export const OBJECT_STORAGE_MESH_PORT = 3900;

/**
 * The mesh object-storage port, when any bucket is reachable from the mesh
 * (MESH or PUBLIC). Published in host mode only then, so an org that exposes
 * nothing has no extra port open on its edges. The edge's Caddy site still
 * 403s every request not from the mesh CIDR for an allowlisted bucket.
 */
export async function objectStorageMeshPort(ctx: OrgContext): Promise<number | undefined> {
  // Fail closed: if exposure can't be read, publish nothing extra.
  let n = 0;
  try {
    n = await bucketAccessRepo.countExposed(ctx, ctx.activeOrgId);
  } catch {
    n = 0;
  }
  return n > 0 ? OBJECT_STORAGE_MESH_PORT : undefined;
}

function meshStoragePort(port?: number): NonNullable<ServiceSpec['ports']> {
  return port ? [{ target: port, published: port, protocol: 'tcp', mode: 'host' }] : [];
}

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
    ...meshStoragePort(opts.objectStorageMeshPort),
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
    // DNS-01 token(s) for wildcard certificates — read by the `dns swarmy` /
    // `dns cloudflare` providers from /run/secrets, never the Caddyfile.
    ...(opts.acmeDnsSecrets?.length ? { secrets: opts.acmeDnsSecrets } : {}),
    // The org's edge network (fronted apps) + the PRIVATE control network,
    // where the dashboard vhost / scale-to-zero activator reach
    // `swarmy_controller:3021` — the controller is on no network apps join.
    networks: edgeNetworks(opts.network),
    placement: { constraints: [placementConstraint] },
  };
}

/**
 * Networks every swarmy Caddy (both topologies) joins: the fronted-apps
 * network, the shared `swarmy` overlay (Garage's `swarmy-garage:3900`), and
 * the private `swarmy-control` overlay (the controller upstream). Pure.
 */
export function edgeNetworks(network: string): string[] {
  return [...new Set([network, DEFAULT_NETWORK, SWARMY_CONTROL_NETWORK])];
}

export async function ensureCaddyController(
  ctx: OrgContext,
  options: EnsureControllerOptions = {},
): Promise<EnsureControllerResult> {
  // Observability on ⇒ the controller runs with OTLP exporter env so Caddy's
  // tracing directive can ship edge spans. Direct swarm-kv read (no coupling to
  // the observability module); caller may override via options.otelOrgId.
  let otelOrgId = options.otelOrgId;
  if (otelOrgId === undefined) {
    const obs = await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
    if (obs?.enabled) otelOrgId = ctx.activeOrgId;
  }
  const opts: ResolvedOptions = {
    network: options.network ?? DEFAULT_NETWORK,
    image: options.image ?? defaultEdgeImage(),
    replicas: options.replicas ?? 1,
    publishAdmin: options.publishAdmin ?? false,
    adminOnOverlay: options.adminOnOverlay ?? false,
    targetNodes: options.targetNodes ?? [],
    otelOrgId,
    objectStorageMeshPort: await objectStorageMeshPort(ctx),
    acmeDnsSecrets: options.acmeDnsSecrets,
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
  await ensureControlNetwork(ctx, node.id);

  // Deploy/converge the controller service (create+update idempotent). The container
  // writes its own admin-enabling base config on boot (no host bind mount / root), then
  // swarmy delivers the rendered routes by in-task exec on every apply. A live GLOBAL
  // (edge-per-node) service is swapped out first — swarm can't change mode in place.
  await deployWithModeSwap(
    ctx,
    node.id,
    caddyControllerSpec(opts, placementFor(ctx, opts.targetNodes)),
  );

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
   * Edge image. Defaults to the configured controller image, then
   * `SWARMY_CADDY_EDGE_IMAGE`, then swarmy's Caddy build
   * (`ghcr.io/requestflo/caddy-swarmy:latest`) — the SAME image the controller
   * topology runs, so a topology swap never introduces an unpullable image.
   * Shared cert storage (`storage s3`) needs the swarmy build; the driver's
   * validate() hard-errors when it meets a stock caddy image.
   */
  image?: string;
  otelOrgId?: string;
  /**
   * Docker secret carrying the shared cert store's S3 credentials (see
   * `ingress-certs.ts`). Mounted + pointed at by `AWS_SHARED_CREDENTIALS_FILE`.
   */
  certStoreSecret?: string;
  /** The store's encryption-key secret (mounted beside it). */
  certStoreEncSecret?: string;
  /** ACME DNS-01 token secrets (wildcard certs). */
  acmeDnsSecrets?: EdgeSecretMount[];
}

/**
 * Caddy image fallback (both topologies) when no controller image is
 * configured: `SWARMY_CADDY_EDGE_IMAGE`, else swarmy's Caddy build.
 */
export function defaultEdgeImage(): string {
  return process.env.SWARMY_CADDY_EDGE_IMAGE || DEFAULT_IMAGE;
}

/** Swarm constraint that places one edge task on every ingress-labelled node. */
export const EDGE_PLACEMENT_CONSTRAINT = `node.labels.${INGRESS_NODE_LABEL} == true`;

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
 * - NO admin port published and NO host bind mount — each node's config is
 *   written INSIDE its local task by that node's agent over the docker socket
 *   (`localReload.file`, applyVia 'local'), then `caddy reload`. A container
 *   agent can't write the host FS, so a bind-mounted host dir never worked.
 * - Same data/config volumes as the controller (per-node named volumes) — the
 *   node that ran the controller keeps its certificates across the swap, and
 *   `--resume` restores the last applied config across task restarts.
 * - Joins the org network + `swarmy` (fronted apps, Garage) + the private
 *   `swarmy-control` overlay: the dashboard vhost proxies to
 *   `swarmy_controller:3021` there, and every edge renders it.
 */
export function caddyEdgeSpec(opts: {
  network: string;
  image: string;
  otelOrgId?: string;
  /** Shared cert store credentials secret (edge-per-node + object storage). */
  certStoreSecret?: string;
  /** Its encryption-key secret (imported by the rendered `storage s3` block). */
  certStoreEncSecret?: string;
  /** Publish the mesh-peer object-storage listener on every edge. */
  objectStorageMeshPort?: number;
  /** ACME DNS-01 token secrets (wildcard certs). */
  acmeDnsSecrets?: EdgeSecretMount[];
}): ServiceSpec {
  const certs = opts.certStoreSecret
    ? edgeCertsServiceWiring(opts.certStoreSecret, opts.certStoreEncSecret)
    : undefined;
  const otelEnv = opts.otelOrgId
    ? {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://swarmy-otel-collector:4317',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_SERVICE_NAME: CADDY_EDGE_SERVICE,
        OTEL_RESOURCE_ATTRIBUTES: `swarmy.org_id=${opts.otelOrgId}`,
        OTEL_TRACES_SAMPLER: 'parentbased_always_on',
      }
    : undefined;
  const env = otelEnv || certs ? { ...otelEnv, ...certs?.env } : undefined;
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
    // Same boot as the controller: write a base config (admin on loopback
    // only — reached solely by the in-task `caddy reload`), then run with
    // `--resume` so the autosaved last-applied config survives restarts. The
    // first render lands seconds later via the agent's in-task exec.
    command: [
      'sh',
      '-c',
      `printf '{\\n\\tadmin 127.0.0.1:${CADDY_ADMIN_PORT}\\n}\\n' > ${CADDY_CONFIG_PATH} && ` +
        `exec caddy run --config ${CADDY_CONFIG_PATH} --adapter caddyfile --resume`,
    ],
    ports: [
      { target: 80, published: 80, protocol: 'tcp', mode: 'host' },
      { target: 443, published: 443, protocol: 'tcp', mode: 'host' },
      { target: 443, published: 443, protocol: 'udp', mode: 'host' }, // HTTP/3
      ...meshStoragePort(opts.objectStorageMeshPort),
    ],
    mounts: [
      { type: 'volume', source: DATA_VOLUME, target: '/data' },
      { type: 'volume', source: CONFIG_VOLUME, target: '/config' },
    ],
    // Credentials for the shared `storage s3` cert store ride ONLY in this
    // mounted secret (AWS SDK default chain) — never in the Caddyfile.
    // (+ the DNS-01 token secrets for wildcard certificates, same rule.)
    ...(certs || opts.acmeDnsSecrets?.length
      ? { secrets: [...(certs?.secrets ?? []), ...(opts.acmeDnsSecrets ?? [])] }
      : {}),
    // `swarmy` is also the object store's overlay (`swarmy-garage:3900`);
    // `swarmy-control` carries the dashboard vhost to the controller.
    networks: edgeNetworks(opts.network),
    placement: { constraints: [EDGE_PLACEMENT_CONSTRAINT] },
    restartPolicy: { condition: 'any' },
  };
}

export interface EnsureEdgeResult {
  id: string;
  name: string;
  network: string;
  /** True when a live service of the other mode (the replicated controller) was swapped out. */
  migrated: boolean;
}

/** Docker's refusal when a service spec update flips replicated↔global. */
const MODE_CHANGE_REFUSED = /mode change is not allowed/i;

function specMode(spec: ServiceSpec): 'replicated' | 'global' {
  return spec.mode && 'global' in spec.mode ? 'global' : 'replicated';
}

/**
 * `service.deploy` the swarmy Caddy spec, swapping the live service out first
 * when its MODE differs (replicated controller ↔ global edge). Swarm cannot
 * change a service's mode in place (`HTTP 501 service mode change is not
 * allowed`), so the only path is remove + create — the same move Garage makes
 * on a mode change (apps/agent/src/handlers/storage.ts). The data/config
 * volumes are NAMED volumes, untouched by a service remove, so certificates
 * and the autosaved config survive; there is a brief gap on 80/443 while the
 * new tasks start.
 *
 * Mode is read off live inventory; if that is stale and Docker still refuses
 * the update as a mode change, remove + create once more. Returns whether a
 * swap happened.
 */
export async function deployWithModeSwap(
  ctx: OrgContext,
  managerNodeId: string,
  spec: ServiceSpec,
): Promise<boolean> {
  const want = specMode(spec);
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === spec.name);
  const remove = async (): Promise<void> => {
    try {
      await ctx.hub.dispatch(managerNodeId, 'service.remove', { service: spec.name });
    } catch (e) {
      throw mapDispatchError(e);
    }
  };
  const deploy = () => ctx.hub.dispatch(managerNodeId, 'service.deploy', { spec, pullPolicy: 'missing' });

  let swapped = false;
  if (live && live.mode !== want) {
    await remove();
    swapped = true;
  }
  try {
    await deploy();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (swapped || !MODE_CHANGE_REFUSED.test(message)) throw mapDispatchError(e);
    // Stale inventory: the live service is the other mode after all.
    await remove();
    swapped = true;
    try {
      await deploy();
    } catch (e2) {
      throw mapDispatchError(e2);
    }
  }
  return swapped;
}

/**
 * Deploy/converge the edge-per-node Caddy (geo-edge). A live replicated
 * controller is swapped out first (mode is immutable in place — see
 * {@link deployWithModeSwap}); same service name + volumes keep the certs.
 */
export async function ensureCaddyEdge(
  ctx: OrgContext,
  options: EnsureEdgeOptions = {},
): Promise<EnsureEdgeResult> {
  let otelOrgId = options.otelOrgId;
  if (otelOrgId === undefined) {
    const obs = await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
    if (obs?.enabled) otelOrgId = ctx.activeOrgId;
  }
  const network = options.network ?? DEFAULT_NETWORK;
  const image = options.image ?? defaultEdgeImage();
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
  await ensureControlNetwork(ctx, node.id);

  const migrated = await deployWithModeSwap(
    ctx,
    node.id,
    caddyEdgeSpec({
      network,
      image,
      otelOrgId,
      certStoreSecret: options.certStoreSecret,
      certStoreEncSecret: options.certStoreEncSecret,
      objectStorageMeshPort: await objectStorageMeshPort(ctx),
      acmeDnsSecrets: options.acmeDnsSecrets,
    }),
  );
  const id = liveService(ctx, CADDY_EDGE_SERVICE)?.id ?? CADDY_EDGE_SERVICE;
  return { id, name: CADDY_EDGE_SERVICE, network, migrated };
}

/** Whether any of the org's nodes carries `swarmy.node.ingress=true` (edge placement target). */
export function anyIngressLabelledNode(ctx: OrgContext): boolean {
  return ctx.hub
    .nodeInventory(ctx.activeOrgId, true)
    .some((n) => n.labels[INGRESS_NODE_LABEL] === 'true');
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
