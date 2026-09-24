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
import { abacProcedure } from '../abac';
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
  presignObjectUrl,
  rotateAccessKey,
  setQuota,
  setWebsite,
} from '../services/buckets.service';
import { MAX_PRESIGN_EXPIRES_SECONDS } from '../services/s3-presign';
import {
  BUCKET_ACCESS_MODES,
  bucketAccessMode,
  bucketEndpoints,
  publicS3DomainFor,
  setBucketAccess,
  setPublicS3Domain,
  type BucketAccessMode,
} from '../services/bucket-access.service';
import { applyObjectStorageExposure, edgeMeshIps, orgDashboardDomain } from '../services/ingress.service';
import type { OrgContext } from '../context';

const accessMode = z.enum(BUCKET_ACCESS_MODES as [BucketAccessMode, ...BucketAccessMode[]]);

/** One bucket's reachability + the concrete endpoints it has. */
async function accessView(ctx: OrgContext, bucketId: string) {
  const bucket = await getBucket(ctx, bucketId);
  const [mode, dashboard, meshIps] = await Promise.all([
    bucketAccessMode(ctx, bucket.id),
    orgDashboardDomain(ctx),
    edgeMeshIps(ctx),
  ]);
  const publicDomain = await publicS3DomainFor(ctx, dashboard);
  return {
    bucketId: bucket.id,
    bucket: bucket.name,
    mode,
    publicDomain: publicDomain.domain ?? null,
    publicDomainCustom: publicDomain.custom,
    meshAvailable: meshIps.length > 0,
    endpoints: bucketEndpoints({ bucket: bucket.name, mode, publicDomain: publicDomain.domain, edgeMeshIps: meshIps }),
  };
}

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
  deleteBucket: abacProcedure('data.destroy')
    .input(DeleteBucketInput)
    .mutation(({ ctx, input }) => deleteBucket(ctx, input.bucketId)),

  /** Mints a key — the secret is returned ONCE and never retrievable again. */
  createKey: adminProcedure
    .input(CreateBucketKeyInput)
    .mutation(({ ctx, input }) => createKey(ctx, input.name)),

  deleteKey: abacProcedure('data.destroy')
    .input(DeleteBucketKeyInput)
    .mutation(({ ctx, input }) => deleteKey(ctx, input.accessKeyId)),

  /**
   * Mint a replacement key with identical grants, swap attached apps onto it
   * (versioned Docker secret + redeploy), delete the old key. The new secret is
   * returned ONCE, and only when no attachment consumed it.
   */
  rotateKey: adminProcedure
    .input(z.object({ accessKeyId: z.string().min(1) }))
    .mutation(({ ctx, input }) => rotateAccessKey(ctx, input.accessKeyId)),

  /** Time-limited presigned GET/PUT URL for one object (SigV4, max 7 days). */
  presignUrl: orgProcedure
    .input(
      z.object({
        bucketId: z.string().min(1),
        key: z.string().min(1).max(1024),
        method: z.enum(['GET', 'PUT']).default('GET'),
        expiresSeconds: z.number().int().min(1).max(MAX_PRESIGN_EXPIRES_SECONDS).default(3600),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Sign for where the link will be used: the bucket's public origin,
      // else a mesh edge, else in-cluster (then it only works inside swarmy).
      const view = await accessView(ctx, input.bucketId);
      const origin = (u: string) => new URL(u).origin;
      const endpoint = view.endpoints.public
        ? origin(view.endpoints.public)
        : view.endpoints.mesh[0]
          ? origin(view.endpoints.mesh[0])
          : undefined;
      const signed = await presignObjectUrl(ctx, { ...input, endpoint });
      return { ...signed, reachableFrom: view.endpoints.public ? 'internet' : endpoint ? 'mesh' : 'cluster' };
    }),

  /** Who can reach this bucket's S3 API (INTERNAL / MESH / PUBLIC) + its endpoints. */
  access: orgProcedure
    .input(z.object({ bucketId: z.string().min(1) }))
    .query(({ ctx, input }) => accessView(ctx, input.bucketId)),

  /** Change one bucket's reachability; the edges re-render (and redeploy when ports change). */
  setAccess: adminProcedure
    .input(z.object({ bucketId: z.string().min(1), mode: accessMode }))
    .mutation(async ({ ctx, input }) => {
      const res = await setBucketAccess(ctx, { ...input, dashboardDomain: await orgDashboardDomain(ctx) });
      await applyObjectStorageExposure(ctx, res.edgePortsChanged);
      return accessView(ctx, res.bucketId);
    }),

  /** Set (or clear → derived from the dashboard domain) the public S3 hostname. */
  setPublicDomain: adminProcedure
    .input(z.object({ domain: z.string().max(253).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const domain = await setPublicS3Domain(ctx, input.domain);
      await applyObjectStorageExposure(ctx, false);
      return { domain };
    }),

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
