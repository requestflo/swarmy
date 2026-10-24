/**
 * Bucket lifecycle — what happens to files as they age. The rules live on the
 * bucket in Garage (S3 Get/Put/DeleteBucketLifecycle), never in swarmy's
 * store; Garage applies them once a day. An expiry rule deletes files for
 * good, so writes are gated on `data.destroy` (router) and audited here.
 */
import { nameLifecycleRules, type BucketLifecycleView, type LifecycleRuleView, type SetBucketLifecycleInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { buildLifecycleXml, parseLifecycleXml } from './bucket-lifecycle-xml';
import { bucketS3Call, isNotConfigured, openBucketS3, type BucketS3Session } from './bucket-s3-call';

async function readRules(ctx: OrgContext, s: BucketS3Session): Promise<LifecycleRuleView[]> {
  const res = await bucketS3Call(ctx, s, { method: 'GET', subresource: 'lifecycle' });
  return isNotConfigured(res) ? [] : parseLifecycleXml(res.body);
}

export async function getBucketLifecycle(ctx: OrgContext, bucketId: string): Promise<BucketLifecycleView> {
  // Lifecycle needs read (get) / write (put, delete) — never owner.
  const s = await openBucketS3(ctx, bucketId, { owner: false });
  return { bucketId: s.bucket.id, bucket: s.bucket.name, rules: await readRules(ctx, s) };
}

/** Name unnamed rules and refuse duplicate ids (S3 requires them unique). Pure. */
export function prepareLifecycleRules(rules: readonly LifecycleRuleView[]): LifecycleRuleView[] {
  const named = nameLifecycleRules(rules);
  const ids = named.map((r) => r.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw commandRejected(`two rules are both called "${dup}" — rule names must be unique`);
  return named;
}

/** One line per rule for the audit trail ("tmp/ · delete 7d"). Pure. */
export function lifecycleAuditSummary(rules: readonly LifecycleRuleView[]): string[] {
  return rules.map((r) =>
    [
      r.prefix || '(whole bucket)',
      r.expireAfterDays !== null ? `delete ${r.expireAfterDays}d` : r.expireOnDate ? `delete on ${r.expireOnDate}` : '',
      r.abortUploadsAfterDays !== null ? `clear uploads ${r.abortUploadsAfterDays}d` : '',
      r.enabled ? '' : 'paused',
    ]
      .filter(Boolean)
      .join(' · '),
  );
}

/** Replace the bucket's lifecycle rules; no rules removes them. */
export async function setBucketLifecycle(ctx: OrgContext, input: SetBucketLifecycleInput): Promise<BucketLifecycleView> {
  const rules = prepareLifecycleRules(input.rules);
  const s = await openBucketS3(ctx, input.bucketId, { owner: false });
  const before = await readRules(ctx, s);
  if (rules.length === 0) {
    await bucketS3Call(ctx, s, { method: 'DELETE', subresource: 'lifecycle' });
  } else {
    await bucketS3Call(ctx, s, { method: 'PUT', subresource: 'lifecycle', body: buildLifecycleXml(rules) });
  }
  await writeAudit(ctx, {
    action: 'buckets.setLifecycle',
    targetType: 'bucket',
    targetId: s.bucket.id,
    metadata: { bucket: s.bucket.name, from: lifecycleAuditSummary(before), to: lifecycleAuditSummary(rules) },
  });
  return { bucketId: s.bucket.id, bucket: s.bucket.name, rules };
}
