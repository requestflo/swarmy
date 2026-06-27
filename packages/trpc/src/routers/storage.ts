/**
 * Replicated object store router (epic: volumes-dr, P2 — Layer 3).
 * Mirrors `ingress.ts`: config get + setDriver + enable/disable + status +
 * previewDeployment for the swarmy-managed Garage S3 cluster.
 */
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  disable,
  enable,
  getConfig,
  previewDeployment,
  setDriver,
  status,
} from '../services/replicatedStore.service';

export const storageRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),
  status: orgProcedure.query(({ ctx }) => status(ctx)),

  setDriver: adminProcedure
    .input(
      z.object({
        driver: z.enum(['garage', 'none']),
        replicationFactor: z.number().int().min(1).max(9).optional(),
        region: z.string().optional(),
        memberNodeIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setDriver(ctx, input)),

  enable: adminProcedure.mutation(({ ctx }) => enable(ctx)),
  disable: adminProcedure.mutation(({ ctx }) => disable(ctx)),
  previewDeployment: adminProcedure.query(({ ctx }) => previewDeployment(ctx)),
});
