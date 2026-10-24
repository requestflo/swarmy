/**
 * Bucket CORS — "browsers allowed to fetch directly". The rules live on the
 * bucket in Garage (S3 Get/Put/DeleteBucketCors), never in swarmy's store;
 * the view is read back from Garage every time. Writes are audited.
 */
import {
  checkCorsOrigin,
  foldCorsRules,
  type BucketCorsView,
  type CorsRuleView,
  type SetBucketCorsInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { buildCorsXml, corsRulesFor, parseCorsXml } from './bucket-cors-xml';
import { bucketS3Call, isNotConfigured, openBucketS3, type BucketS3Session } from './bucket-s3-call';

function view(s: BucketS3Session, rules: CorsRuleView[]): BucketCorsView {
  return { bucketId: s.bucket.id, bucket: s.bucket.name, ...foldCorsRules(rules), wildcards: s.major >= 2, rules };
}

async function readRules(ctx: OrgContext, s: BucketS3Session): Promise<CorsRuleView[]> {
  const res = await bucketS3Call(ctx, s, { method: 'GET', subresource: 'cors' });
  return isNotConfigured(res) ? [] : parseCorsXml(res.body);
}

export async function getBucketCors(ctx: OrgContext, bucketId: string): Promise<BucketCorsView> {
  const s = await openBucketS3(ctx, bucketId, { owner: true });
  return view(s, await readRules(ctx, s));
}

/**
 * Validate a requested policy against what the engine can match. Returns the
 * normalised, de-duplicated origins. Pure.
 */
export function validateCorsPolicy(input: Pick<SetBucketCorsInput, 'origins' | 'methods'>, wildcards: boolean): string[] {
  const origins: string[] = [];
  for (const raw of input.origins) {
    const check = checkCorsOrigin(raw, { wildcards });
    if (!check.ok) throw commandRejected(check.reason);
    if (!origins.includes(check.origin)) origins.push(check.origin);
  }
  if (origins.length > 0 && input.methods.length === 0) {
    throw commandRejected('pick at least one method browsers may use');
  }
  return origins;
}

/** Replace the bucket's CORS rules; no origins removes them. */
export async function setBucketCors(ctx: OrgContext, input: SetBucketCorsInput): Promise<BucketCorsView> {
  const s = await openBucketS3(ctx, input.bucketId, { owner: true });
  const origins = validateCorsPolicy(input, s.major >= 2);
  const methods = [...new Set(input.methods)];
  // Read first: the audit records what the rules were.
  const before = foldCorsRules(await readRules(ctx, s));
  const policy = { origins, methods, maxAgeSeconds: input.maxAgeSeconds };
  if (origins.length === 0) {
    await bucketS3Call(ctx, s, { method: 'DELETE', subresource: 'cors' });
  } else {
    await bucketS3Call(ctx, s, { method: 'PUT', subresource: 'cors', body: buildCorsXml(policy) });
  }
  await writeAudit(ctx, {
    action: 'buckets.setCors',
    targetType: 'bucket',
    targetId: s.bucket.id,
    metadata: {
      bucket: s.bucket.name,
      from: { origins: before.origins, methods: before.methods, maxAgeSeconds: before.maxAgeSeconds },
      to: policy,
    },
  });
  return view(s, corsRulesFor(policy));
}
