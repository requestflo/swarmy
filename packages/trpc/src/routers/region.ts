import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { getRegionReplicas, listKnownRegions, setRegionReplicas } from '../services/region.service';

/**
 * Per-region replicas (epic #7). Read/declare how many replicas a service wants
 * in each region; persisted as Docker labels, reconciled by the worker. No DB.
 */
export const regionRouter = router({
  /** Declared per-region plan + known regions for a service. */
  get: orgProcedure
    .input(z.object({ serviceId: z.string().min(1) }))
    .query(({ ctx, input }) => getRegionReplicas(ctx, input.serviceId)),

  /** Distinct regions across the org's live nodes (+ already-declared ones). */
  knownRegions: orgProcedure.query(({ ctx }) => listKnownRegions(ctx)),

  /** Declare N replicas for one region (N=0 clears it). */
  set: orgProcedure
    .input(
      z.object({
        serviceId: z.string().min(1),
        region: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'region must be a label-safe token'),
        replicas: z.number().int().min(0).max(1000),
      }),
    )
    .mutation(({ ctx, input }) =>
      setRegionReplicas(ctx, {
        id: input.serviceId,
        region: input.region,
        replicas: input.replicas,
      }),
    ),
});
