import { z } from 'zod';
import {
  AttachBucketInput,
  CreateBucketInput,
  CreateBucketKeyInput,
  DeleteBucketInput,
  DeleteBucketKeyInput,
  DetachBucketInput,
  GrantKeyOnBucketInput,
  SetBucketQuotaInput,
  SetBucketWebsiteInput,
} from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  attachToService,
  createBucket,
  createKey,
  deleteBucket,
  deleteKey,
  detach,
  getBucket,
  grantKeyOnBucket,
  listKeys,
  overview,
  setQuota,
  setWebsite,
} from '../services/buckets.service';

/**
 * Object storage buckets — Garage bucket/key CRUD, quotas, usage, service
 * attach (slice A4). All state lives in Garage (admin API v1) reached via
 * one-shot curl containers on a storage node; nothing here touches Prisma
 * beyond the org's StorageCluster row (admin endpoint + token).
 */
export const objectStorageRouter = router({
  /** Store state + every bucket with usage — the buckets page's main query. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Bucket detail: usage, per-key grants, quota, website flag, attachments. */
  get: orgProcedure
    .input(z.object({ bucketId: z.string().min(1) }))
    .query(({ ctx, input }) => getBucket(ctx, input.bucketId)),

  /** All access keys (ids + names — secrets are never listed). */
  listKeys: orgProcedure.query(({ ctx }) => listKeys(ctx)),

  createBucket: adminProcedure
    .input(CreateBucketInput)
    .mutation(({ ctx, input }) => createBucket(ctx, input)),

  /** Refused while the bucket still holds objects or is attached to a service. */
  deleteBucket: adminProcedure
    .input(DeleteBucketInput)
    .mutation(({ ctx, input }) => deleteBucket(ctx, input.bucketId)),

  /** Mints a key — the secret is returned ONCE and never retrievable again. */
  createKey: adminProcedure
    .input(CreateBucketKeyInput)
    .mutation(({ ctx, input }) => createKey(ctx, input.name)),

  deleteKey: adminProcedure
    .input(DeleteBucketKeyInput)
    .mutation(({ ctx, input }) => deleteKey(ctx, input.accessKeyId)),

  /** Grant (allow) or revoke (deny) read/write/owner for a key on a bucket. */
  grantKeyOnBucket: adminProcedure
    .input(GrantKeyOnBucketInput)
    .mutation(({ ctx, input }) => grantKeyOnBucket(ctx, input)),

  /** Set/clear the bucket's max-size / max-objects quota (null = unlimited). */
  setQuota: adminProcedure
    .input(SetBucketQuotaInput)
    .mutation(({ ctx, input }) => setQuota(ctx, input)),

  /** Toggle public static-website serving (OFF by default). */
  setWebsite: adminProcedure
    .input(SetBucketWebsiteInput)
    .mutation(({ ctx, input }) => setWebsite(ctx, input)),

  /** Scoped key + S3_* env + Docker-secret injection into an app service. */
  attachToService: adminProcedure
    .input(AttachBucketInput)
    .mutation(({ ctx, input }) => attachToService(ctx, input)),

  detach: adminProcedure
    .input(DetachBucketInput)
    .mutation(({ ctx, input }) => detach(ctx, input.appService)),
});
