import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  getMirror,
  listOffsiteBuckets,
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  mirrorNow,
  removeMirror,
  restoreFromOffsite,
  saveMirror,
} from '../services/offsiteMirror.service';

const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/, 'invalid bucket name');

/**
 * Off-site mirror of swarmy's object store (Garage → any S3 destination) and
 * the restore back. Config + runs are admin-only; reading status is org-wide.
 */
export const offsiteMirrorRouter = router({
  /** Config, destinations (with eligibility), last run, recent runs. */
  get: orgProcedure.query(({ ctx }) => getMirror(ctx)),

  save: adminProcedure
    .input(
      z.object({
        targetId: z.string().min(1),
        allBuckets: z.boolean(),
        buckets: z.array(bucketName).max(500).optional(),
        prefix: z.string().max(200).optional(),
        everyMinutes: z.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES).optional(),
        /** copy = never delete off-site (default); sync = deletes follow after the grace window. */
        mode: z.enum(['copy', 'sync']).optional(),
        graceDays: z.number().int().min(1).max(365).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => saveMirror(ctx, input)),

  /** Stop mirroring. The off-site copy itself is never deleted. */
  remove: adminProcedure.mutation(({ ctx }) => removeMirror(ctx)),

  /** Start a run now; returns once it is recorded (the copy runs in the background). */
  mirrorNow: adminProcedure.mutation(({ ctx }) => mirrorNow(ctx)),

  /** Bucket folders present off-site — the restore dialog's preview. */
  offsiteBuckets: adminProcedure.query(({ ctx }) => listOffsiteBuckets(ctx)),

  /** Copy the off-site copy back into Garage. Confirm = the destination's name. */
  restore: adminProcedure
    .input(
      z.object({
        confirm: z.string(),
        buckets: z.array(bucketName).max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreFromOffsite(ctx, input)),
});
