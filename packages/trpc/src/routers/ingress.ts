import { z } from 'zod';
import { TlsMode } from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  addDomain,
  getConfig,
  listDomains,
  listDrivers,
  previewConfig,
  removeDomain,
  setDriver,
  setEnabled,
} from '../services/ingress.service';

const driverEnum = z.enum(['caddy', 'traefik', 'none']);

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

  addDomain: orgProcedure
    .input(
      z.object({
        host: z.string().min(1),
        serviceId: z.string(),
        targetPort: z.number().int().min(1).max(65535),
        tls: TlsMode.default('auto'),
        pathPrefix: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => addDomain(ctx, input)),

  removeDomain: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeDomain(ctx, input.id)),

  previewConfig: orgProcedure
    .input(z.object({ driver: driverEnum.optional() }))
    .query(({ ctx, input }) => previewConfig(ctx, input.driver)),
});
