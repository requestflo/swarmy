/**
 * Replicated object store router (epic: volumes-dr, P2 — Layer 3).
 * Mirrors `ingress.ts`: config get + setDriver + enable/disable + status
 * for the swarmy-managed Garage S3 cluster.
 */
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { getEngineUpgrade, startEngineUpgrade } from '../services/engine-upgrade.service';
import {
  disable,
  enable,
  getConfig,
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
  disable: abacProcedure('data.destroy').mutation(({ ctx }) => disable(ctx)),
  /** Engine version the store runs, whether an upgrade is available, and the last/current run. */
  engineUpgrade: orgProcedure.query(({ ctx }) => getEngineUpgrade(ctx)),
  /** Start the in-place engine upgrade (Garage v1 → v2): brief pause, automatic rollback on failure. */
  startEngineUpgrade: adminProcedure.mutation(({ ctx }) => startEngineUpgrade(ctx)),
});
