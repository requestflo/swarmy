/**
 * Cluster-volume router (epic: volumes-dr, P3 — opt-in Swarm CSI volumes).
 */
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { deregister, list, register } from '../services/clusterVolume.service';

const accessMode = z.enum(['single-writer', 'multi-writer', 'multi-reader']);

export const volumesRouter = router({
  listCluster: orgProcedure.query(({ ctx }) => list(ctx)),

  registerCluster: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        csiDriver: z.string().min(1),
        accessMode: accessMode.optional(),
        capacityBytes: z.number().int().positive().optional(),
        options: z.record(z.string()).optional(),
        serviceId: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => register(ctx, input)),

  deregisterCluster: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deregister(ctx, input.id)),
});
