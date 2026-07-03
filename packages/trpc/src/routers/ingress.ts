import { z } from 'zod';
import { TlsMode } from '@swarmy/core';
import { RouteProtectionSchema } from '@swarmy/ingress';
import { adminProcedure, orgProcedure, router } from '../trpc';
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
  setDriver,
  setEnabled,
  setHaStorage,
  setOnDemandTls,
  setTargetNodes,
  setTunnel,
} from '../services/ingress.service';
import {
  detectServicePorts,
  listServiceRoutes,
  setServiceRoutes,
} from '../services/ingress-routes-api';

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
      }),
    )
    .mutation(({ ctx, input }) => addDomain(ctx, input)),

  removeDomain: orgProcedure
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

  /** Configure Caddy HA shared-cert storage (Redis). `null` clears it. */
  setHaStorage: adminProcedure
    .input(
      z
        .object({
          host: z.string().min(1),
          port: z.number().int().min(1).max(65535).optional(),
          db: z.number().int().nonnegative().optional(),
          keyPrefix: z.string().optional(),
          tlsEnabled: z.boolean().optional(),
          username: z.string().optional(),
          password: z.string().optional(),
          encryptionKey: z.string().optional(),
        })
        .nullable(),
    )
    .mutation(({ ctx, input }) => setHaStorage(ctx, input)),

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
   * Cloudflare tunnels. Nested here so it is reachable without a root.ts edit;
   * the INTEGRATION snippet also mounts it top-level as `tunnels` if preferred.
   */
  tunnels: tunnelsRouter,
});
