import type { ServiceSpec } from '@swarmy/core/protocol';
import {
  buildCaddyfile,
  CADDY_ADMIN_PORT,
  CADDY_CONFIG_PATH,
  CADDY_CONTROLLER_SERVICE,
  IngressConfigSchema,
} from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { liveService } from './service.service';

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
}

export interface EnsureControllerResult {
  /** Live Docker service id (falls back to the service name until inventory catches up). */
  id: string;
  name: string;
  network: string;
  /** Admin `/load` URL the driver should target (set `extraConfig.adminUrl` to this on the org config). */
  adminUrl: string;
}

type ResolvedOptions = Required<EnsureControllerOptions>;

/**
 * Base Caddyfile written to the manager host for the controller's first boot —
 * it only enables the admin endpoint (no routes yet). Reuses the real renderer so
 * the `admin 0.0.0.0:2019` directive stays in lockstep with the driver's output.
 */
function baseCaddyfile(): string {
  return buildCaddyfile(
    IngressConfigSchema.parse({
      driver: 'caddy',
      orgId: '_controller',
      domains: [],
      globalOptions: { extraConfig: { applyVia: 'admin' } },
    }),
  );
}

function controllerSpec(opts: ResolvedOptions): ServiceSpec {
  const ports: NonNullable<ServiceSpec['ports']> = [
    { target: 80, published: 80, protocol: 'tcp', mode: 'ingress' },
    { target: 443, published: 443, protocol: 'tcp', mode: 'ingress' },
  ];
  if (opts.publishAdmin) {
    ports.push({ target: CADDY_ADMIN_PORT, published: CADDY_ADMIN_PORT, protocol: 'tcp', mode: 'ingress' });
  }
  return {
    name: CADDY_CONTROLLER_SERVICE,
    image: opts.image,
    mode: { replicated: { replicas: opts.replicas } },
    labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress' },
    command: ['caddy', 'run', '--resume', '--config', CADDY_CONFIG_PATH, '--adapter', 'caddyfile'],
    ports,
    mounts: [
      // First-boot base config (admin endpoint). Pinned to the manager via the
      // placement constraint below so the bind source — written by the agent on
      // the manager — is co-located; each apply rewrites it for `--resume`.
      { type: 'bind', source: CADDY_CONFIG_PATH, target: CADDY_CONFIG_PATH, readOnly: false },
      { type: 'volume', source: DATA_VOLUME, target: '/data' },
      { type: 'volume', source: CONFIG_VOLUME, target: '/config' },
    ],
    networks: [opts.network],
    placement: { constraints: ['node.role == manager'] },
  };
}

export async function ensureCaddyController(
  ctx: OrgContext,
  options: EnsureControllerOptions = {},
): Promise<EnsureControllerResult> {
  const opts: ResolvedOptions = {
    network: options.network ?? DEFAULT_NETWORK,
    image: options.image ?? DEFAULT_IMAGE,
    replicas: options.replicas ?? 1,
    publishAdmin: options.publishAdmin ?? true,
  };
  const node = await resolveManagerNode(ctx);

  // 1. Write the base Caddyfile to the manager host so the controller's bind mount
  //    resolves on first boot (mirrors observability-stack's file-then-deploy order).
  try {
    await ctx.hub.dispatch(node.id, 'applyIngress', {
      rendered: {
        driver: 'caddy-controller-base',
        files: [{ path: CADDY_CONFIG_PATH, contents: baseCaddyfile(), mode: 0o644 }],
        serviceLabels: [],
      },
    });
  } catch (e) {
    throw mapDispatchError(e);
  }

  // 2. Deploy/converge the controller service (create+update idempotent).
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', {
      spec: controllerSpec(opts),
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
