import { z } from 'zod';
import { SetBucketCorsInput, SetBucketLifecycleInput } from '@swarmy/core';
import { orgProcedure } from '../trpc';
import { abacProcedure } from '../abac';
import { getBucketCors, setBucketCors } from '../services/bucket-cors.service';
import { getBucketLifecycle, setBucketLifecycle } from '../services/bucket-lifecycle.service';

const BucketId = z.object({ bucketId: z.string().min(1) });

/**
 * A bucket's own rules, stored on the bucket in Garage (S3 API): which
 * browsers may fetch it directly (CORS) and what happens to files as they age
 * (lifecycle). Spread into the buckets router.
 */
export const bucketRuleProcedures = {
  /** The bucket's CORS rules, read back from Garage. */
  getCors: orgProcedure.input(BucketId).query(({ ctx, input }) => getBucketCors(ctx, input.bucketId)),

  /** Replace the bucket's CORS rules (no origins = remove them). Audited `buckets.setCors`. */
  setCors: abacProcedure('data.configure')
    .input(SetBucketCorsInput)
    .mutation(({ ctx, input }) => setBucketCors(ctx, input)),

  /** The bucket's lifecycle rules (expiry, unfinished-upload clean-up), read back from Garage. */
  getLifecycle: orgProcedure.input(BucketId).query(({ ctx, input }) => getBucketLifecycle(ctx, input.bucketId)),

  /**
   * Replace the bucket's lifecycle rules (none = remove them). An expiry rule
   * deletes files for good, so this is gated like any data destruction.
   * Audited `buckets.setLifecycle`.
   */
  setLifecycle: abacProcedure('data.destroy')
    .input(SetBucketLifecycleInput)
    .mutation(({ ctx, input }) => setBucketLifecycle(ctx, input)),
};
