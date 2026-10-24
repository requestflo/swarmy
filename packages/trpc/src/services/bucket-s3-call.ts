/**
 * One S3 bucket-configuration call (`?cors`, `?lifecycle`) against Garage,
 * the same way every other bucket op reaches it: a `container.runOnce` curl on
 * a manager, attached to the store overlay, hitting `swarmy-garage:3900` by
 * swarm DNS (the store publishes nothing). Garage's admin API has no CORS or
 * lifecycle endpoints, so these go through the S3 API itself.
 *
 * Signing: the controller presigns the exact request with its platform key
 * (`swarmy-presign`, granted on the bucket on demand) using the pure SigV4
 * presigner, so the one-shot container gets a URL that authorizes that single
 * call for five minutes — no key, no secret, nothing reusable leaves the
 * controller.
 */
import type { BucketDetailView } from '@swarmy/core';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError } from '../errors';
import {
  STATUS_MARKER,
  adminRunOncePayload,
  ensurePresignGrant,
  ensurePresignKey,
  garageS3Endpoint,
  getBucket,
  parseAdminOutput,
  requireStore,
  type StoreHandle,
} from './buckets.service';
import type { GarageMajor } from './garage-admin';
import { presignS3Url } from './s3-presign';
import { s3ErrorText } from './s3-xml';
import { resolveManagerNode } from './dispatch.service';

export type BucketSubresource = 'cors' | 'lifecycle';

/** How long the one-shot's presigned URL stays valid. */
const CALL_EXPIRES_SECONDS = 300;

/**
 * One-shot script: the presigned URL, method and (optional) XML body ride as
 * env. Output = `__SWARMY_STATUS__:<code>` + response body (same framing as
 * the admin script, parsed by `parseAdminOutput`).
 */
export function buildS3Script(): string {
  return [
    'set -eu',
    'if [ -n "${S3_BODY:-}" ]; then',
    '  code=$(curl -sS -o /tmp/swarmy.out -w \'%{http_code}\' -X "$S3_METHOD" -H "Content-Type: application/xml" --data-binary "$S3_BODY" "$S3_URL")',
    'else',
    '  code=$(curl -sS -o /tmp/swarmy.out -w \'%{http_code}\' -X "$S3_METHOD" "$S3_URL")',
    'fi',
    `echo "${STATUS_MARKER}$code"`,
    'cat /tmp/swarmy.out',
  ].join('\n');
}

export interface BucketS3Request {
  method: 'GET' | 'PUT' | 'DELETE';
  subresource: BucketSubresource;
  body?: string;
}

/** A bucket opened for sub-resource calls: its store, its detail, the signing key (granted). */
export interface BucketS3Session {
  store: StoreHandle;
  bucket: BucketDetailView;
  creds: { accessKeyId: string; secretAccessKey: string };
  /** Garage generation the store runs (CORS wildcard support differs). */
  major: GarageMajor;
}

/**
 * Resolve the bucket (proves it is in THIS org's store — 404 otherwise) and
 * make sure the signing key holds what the calls need. One session serves a
 * read-modify-write without re-checking.
 */
export async function openBucketS3(ctx: OrgContext, bucketId: string, need: { owner: boolean }): Promise<BucketS3Session> {
  const store = await requireStore(ctx);
  const bucket = await getBucket(ctx, bucketId);
  const creds = await ensurePresignKey(ctx, store);
  await ensurePresignGrant(ctx, store, bucket, creds.accessKeyId, need);
  return { store, bucket, creds, major: store.major };
}

/** Garage's "nothing configured" answer: 204 on v1, 404 NoSuch… on v2. */
export function isNotConfigured(res: { status: number; body: string }): boolean {
  return res.status === 204 || (res.status === 404 && /NoSuch(CORS|Lifecycle)Configuration/.test(res.body));
}

/** Run one bucket sub-resource call. Throws a readable refusal on any other HTTP ≥ 400. */
export async function bucketS3Call(
  ctx: OrgContext,
  session: BucketS3Session,
  req: BucketS3Request,
): Promise<{ status: number; body: string }> {
  const url = presignS3Url({
    endpoint: garageS3Endpoint(),
    region: session.store.region,
    bucket: session.bucket.name,
    key: '',
    subresource: req.subresource,
    accessKeyId: session.creds.accessKeyId,
    secretAccessKey: session.creds.secretAccessKey,
    method: req.method,
    expiresSeconds: CALL_EXPIRES_SECONDS,
    now: new Date(),
  });
  const node = await resolveManagerNode(ctx);
  let res: RunOnceResult;
  try {
    res = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      adminRunOncePayload(buildS3Script(), { S3_METHOD: req.method, S3_URL: url, ...(req.body ? { S3_BODY: req.body } : {}) }),
      { timeoutMs: 60_000 },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  const { status, body } = parseAdminOutput(res.output);
  if (res.exitCode !== 0 && status === 0) {
    throw commandRejected(`object store unreachable: ${res.output.slice(-300) || 'curl failed'}`);
  }
  if (status >= 400 && !isNotConfigured({ status, body })) {
    throw commandRejected(`object store refused the ${req.subresource} rules (${status}): ${s3ErrorText(body) || 'no detail'}`);
  }
  return { status, body };
}
