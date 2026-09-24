import { z } from 'zod';
import { TlsMode } from '@swarmy/core';
import { RouteProtectionSchema, WwwModeSchema } from '@swarmy/ingress';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { tunnelsRouter } from './tunnels';
import { ensureCaddyController } from '../services/ingress-controller';
import {
  addDomain,
  getConfig,
  getControllerImage,
  listDomains,
  listDrivers,
  previewConfig,
  removeDomain,
  setControllerImage,
  setDomainWww,
  setDriver,
  setEnabled,
  setOnDemandTls,
  setTargetNodes,
  setTunnel,
  setTopology,
} from '../services/ingress.service';
import {
  detectServicePorts,
  listServiceRoutes,
  setServiceRoutes,
} from '../services/ingress-routes-api';
import {
  getDomainStatus,
  skipDomainVerification,
  verifyDomainNow,
} from '../services/domain-verify.service';

const driverEnum = z.enum(['caddy', 'traefik', 'none', 'cloudflared', 'nginx', 'haproxy']);

/** One ingress route as written to the `swarmy.ingress.routes` service label. */
const routeInput = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['auto', 'off', 'manual']).default('auto'),
  path: z.string().optional(),
  stripPrefix: z.boolean().optional(),
  middlewares: z.array(z.string()).optional(),
  driver: z.string().optional(),
  /** Edge protections (rate limit, IP rules, body cap, bots, required headers). */
  protection: RouteProtectionSchema.optional(),
  /** Apex ↔ www toggle for this route's host. */
  www: WwwModeSchema.optional(),
});

export const ingressRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  listDrivers: orgProcedure.query(() => listDrivers()),

  setDriver: adminProcedure
    .input(z.object({ driver: driverEnum }))
    .mutation(({ ctx, input }) => setDriver(ctx, input.driver)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input.enabled)),

  /** Domain routes read live off service labels; `stack` scopes to one Docker stack. */
  listDomains: orgProcedure
    .input(z.object({ stack: z.string().optional() }).optional())
    .query(({ ctx, input }) => listDomains(ctx, input?.stack)),

  /** Deploy/converge the native Caddy ingress controller (swarmy-ingress-caddy)
   *  on the swarm; swarmy pushes rendered routing to its admin API. Idempotent.
   *  Deploys the configured controller image (rate-limit builds) and honours
   *  the configured target nodes, when set. */
  ensureController: adminProcedure.mutation(async ({ ctx }) => {
    const config = await getConfig(ctx);
    return ensureCaddyController(ctx, {
      image: (await getControllerImage(ctx)) ?? undefined,
      targetNodes: config.targetNodes,
    });
  }),

  /** Switch the edge topology (geo-edge): 'edge-per-node' deploys a GLOBAL
   *  host-mode Caddy on every ingress node with per-node region-aware configs
   *  delivered in-task; 'controller' restores the classic replicated service.
   *  Swarm can't change mode in place, so the service is removed + recreated
   *  (cert volumes kept, seconds of downtime). The setting persists only once
   *  the new service deployed. */
  setTopology: adminProcedure
    .input(z.object({ topology: z.enum(['controller', 'edge-per-node']) }))
    .mutation(({ ctx, input }) => setTopology(ctx, input.topology)),

  /** Set (or clear) the ingress-controller image — the swarmy Caddy build
   *  (docker/caddy-swarmy) is required for per-route rate limits. */
  setControllerImage: adminProcedure
    .input(z.object({ image: z.string().min(1).nullable() }))
    .mutation(({ ctx, input }) => setControllerImage(ctx, input.image)),

  /** Pin the ingress controller to specific swarm nodes. A single id pins the
   *  deploy directly (`node.id==`); multiple ids fall back to the
   *  `swarmy.node.ingress` label heuristic (Swarm constraints AND, so a list
   *  can't express "any of these" via node ids). Empty array clears the pin. */
  setTargetNodes: adminProcedure
    .input(z.object({ nodeIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => setTargetNodes(ctx, input.nodeIds)),

  addDomain: orgProcedure
    .input(
      z.object({
        host: z.string().min(1),
        serviceId: z.string(),
        targetPort: z.number().int().min(1).max(65535),
        tls: TlsMode.default('auto'),
        pathPrefix: z.string().optional(),
        /**
         * Per-domain driver override (ingress-strategy epic). `null`/absent =
         * inherit the org default. Persisted in IngressConfig.settings until the
         * Domain.ingressDriver column lands (see INTEGRATION).
         */
        ingressDriver: driverEnum.nullish(),
        /** Also serve / redirect the www companion (`acme.com` ↔ `www.acme.com`). */
        www: WwwModeSchema.nullish(),
      }),
    )
    .mutation(({ ctx, input }) => addDomain(ctx, input)),

  removeDomain: abacProcedure('ingress.write')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeDomain(ctx, input.id)),

  /** All ingress routes carried on one service's `swarmy.ingress.routes` label. */
  listServiceRoutes: orgProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(({ ctx, input }) => listServiceRoutes(ctx, input.serviceId)),

  /**
   * Replace ALL routes for a service in one write (multi-route): validates and
   * serializes the whole array into the single routes label, then re-renders.
   */
  setServiceRoutes: orgProcedure
    .input(z.object({ serviceId: z.string(), routes: z.array(routeInput) }))
    .mutation(({ ctx, input }) => setServiceRoutes(ctx, input.serviceId, input.routes)),

  /** Suggested {port, protocol} for a service, read from the live Docker inventory. */
  detectPorts: orgProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(({ ctx, input }) => detectServicePorts(ctx, input.serviceId)),

  /** Toggle on-demand TLS + set the controller `ask` endpoint URL. */
  setOnDemandTls: adminProcedure
    .input(z.object({ enabled: z.boolean(), askUrl: z.string().url().optional() }))
    .mutation(({ ctx, input }) => setOnDemandTls(ctx, input)),

  /** Configure the Cloudflare tunnel (secrets encrypted at rest). `null` clears it. */
  setTunnel: adminProcedure
    .input(
      z
        .object({
          accountId: z.string().optional(),
          tunnelId: z.string().optional(),
          tunnelName: z.string().optional(),
          image: z.string().optional(),
          replicas: z.number().int().min(1).optional(),
          metricsAddr: z.string().optional(),
          apiToken: z.string().optional(),
          runToken: z.string().optional(),
          credentialsJson: z.string().optional(),
        })
        .nullable(),
    )
    .mutation(({ ctx, input }) => setTunnel(ctx, input)),

  previewConfig: orgProcedure
    .input(z.object({ driver: driverEnum.optional() }))
    .query(({ ctx, input }) => previewConfig(ctx, input.driver)),

  /**
   * Custom-domain status: waiting_dns → verified → issuing → active | error,
   * the exact DNS records to create, what public DNS answers, and the
   * certificate each edge serves. `host` is a routed host (or its companion).
   */
  domainStatus: orgProcedure
    .input(z.object({ host: z.string().min(1) }))
    .query(({ ctx, input }) => getDomainStatus(ctx, input.host)),

  /** Re-check DNS + certificate for a host right now ("Check again"). */
  verifyDomain: abacProcedure('ingress.write')
    .input(z.object({ host: z.string().min(1) }))
    .mutation(({ ctx, input }) => verifyDomainNow(ctx, input.host)),

  /** Set (or clear with `null`) the apex ↔ www toggle on a domain route. */
  setDomainWww: abacProcedure('ingress.write')
    .input(z.object({ id: z.string(), www: WwwModeSchema.nullable() }))
    .mutation(({ ctx, input }) => setDomainWww(ctx, input.id, input.www)),

  /**
   * Treat a host as DNS-verified without the check — for a domain behind an
   * external load balancer / proxy whose IPs swarmy can't know. Audited; this
   * lets the edge request a certificate for a name swarmy could not verify.
   */
  skipDomainVerification: adminProcedure
    .input(z.object({ host: z.string().min(1) }))
    .mutation(({ ctx, input }) => skipDomainVerification(ctx, input.host)),

  /**
   * Cloudflare tunnels. Nested here so it is reachable without a root.ts edit;
   * the INTEGRATION snippet also mounts it top-level as `tunnels` if preferred.
   */
  tunnels: tunnelsRouter,
});
