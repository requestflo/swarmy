import { z } from 'zod';
import { SetBucketCorsInput } from '@swarmy/core';
import { orgProcedure } from '../trpc';
import { abacProcedure } from '../abac';
import { getBucketCors, setBucketCors } from '../services/bucket-cors.service';

const BucketId = z.object({ bucketId: z.string().min(1) });

/**
 * A bucket's own rules, stored on the bucket in Garage (S3 API): which
 * browsers may fetch it directly (CORS). Spread into the buckets router.
 */
export const bucketRuleProcedures = {
  /** The bucket's CORS rules, read back from Garage. */
  getCors: orgProcedure.input(BucketId).query(({ ctx, input }) => getBucketCors(ctx, input.bucketId)),

  /** Replace the bucket's CORS rules (no origins = remove them). Audited `buckets.setCors`. */
  setCors: abacProcedure('data.configure')
    .input(SetBucketCorsInput)
    .mutation(({ ctx, input }) => setBucketCors(ctx, input)),
};
