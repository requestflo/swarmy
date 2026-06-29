import { z } from 'zod';
import { TlsMode } from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { tunnelsRouter } from './tunnels';
import { ensureCaddyController } from '../services/ingress-controller';
import {
  addDomain,
  getConfig,
  listDomains,
  listDrivers,
  previewConfig,
  removeDomain,
  setDriver,
  setEnabled,
  setHaStorage,
  setOnDemandTls,
  setTunnel,
} from '../services/ingress.service';

const driverEnum = z.enum(['caddy', 'traefik', 'none', 'cloudflared', 'nginx', 'haproxy']);

export const ingressRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  listDrivers: orgProcedure.query(() => listDrivers()),

  setDriver: adminProcedure
    .input(z.object({ driver: driverEnum }))
    .mutation(({ ctx, input }) => setDriver(ctx, input.driver)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input.enabled)),

  listDomains: orgProcedure.query(({ ctx }) => listDomains(ctx)),

  /** Deploy/converge the native Caddy ingress controller (swarmy-ingress-caddy)
   *  on the swarm; swarmy pushes rendered routing to its admin API. Idempotent. */
  ensureController: adminProcedure.mutation(({ ctx }) => ensureCaddyController(ctx)),

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
