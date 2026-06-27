import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { createTunnel, deleteTunnel, getTunnel, listTunnels, syncTunnel } from '../services/tunnel.service';

/**
 * Tunnels router (ingress-strategy epic). Manages remotely-managed Cloudflare
 * tunnels: list / create (CF API + connector deploy) / sync (push ingress rules
 * + DNS) / delete. Secrets are write-only; the API token is never returned.
 */
export const tunnelsRouter = router({
  list: orgProcedure.query(({ ctx }) => listTunnels(ctx)),

  get: orgProcedure.query(({ ctx }) => getTunnel(ctx)),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).default('swarmy'),
        accountId: z.string().min(1),
        apiToken: z.string().min(1),
        replicas: z.number().int().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createTunnel(ctx, input)),

  /** Re-push the CF ingress array (and optionally upsert DNS CNAMEs). */
  sync: adminProcedure
    .input(z.object({ zoneId: z.string().optional() }).optional())
    .mutation(({ ctx, input }) => syncTunnel(ctx, { zoneId: input?.zoneId })),

  delete: adminProcedure.mutation(({ ctx }) => deleteTunnel(ctx)),
});
