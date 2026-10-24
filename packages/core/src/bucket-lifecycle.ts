/**
 * Bucket lifecycle — what happens to files as they age (S3
 * PutBucketLifecycleConfiguration on Garage). Limited to what Garage really
 * implements (v1.0.1 and v2.4.1 alike, `api/s3/lifecycle.rs`):
 *  - Expiration by Days (or a Date), and AbortIncompleteMultipartUpload;
 *  - a Filter of Prefix and/or object size — no tags, no transitions, no
 *    noncurrent versions (Garage has no versioning or storage classes).
 * Garage applies the rules once a day. Pure.
 */
import { z } from 'zod';

export const MAX_LIFECYCLE_RULES = 20;
/** A hundred years: the longest "after N days" swarmy accepts. */
export const MAX_LIFECYCLE_DAYS = 36_500;

const Days = z.number().int().min(1).max(MAX_LIFECYCLE_DAYS);

export const LifecycleRuleInput = z
  .object({
    /** Garage rule id; null = swarmy names it. */
    id: z.string().min(1).max(255).nullable().default(null),
    enabled: z.boolean().default(true),
    /** Key prefix the rule applies to; '' = every file in the bucket. */
    prefix: z.string().max(1024).default(''),
    /** Delete files this many days after upload. */
    expireAfterDays: Days.nullable().default(null),
    /** Clear unfinished multipart uploads this many days after they began. */
    abortUploadsAfterDays: Days.nullable().default(null),
    /** Kept as-is from rules set outside swarmy (S3 `Expiration.Date`). */
    expireOnDate: z.string().min(1).max(40).nullable().default(null),
    /** Kept as-is from rules set outside swarmy (S3 size filters, bytes). */
    sizeGreaterThan: z.number().int().min(0).nullable().default(null),
    sizeLessThan: z.number().int().min(1).nullable().default(null),
  })
  .refine((r) => r.expireAfterDays !== null || r.abortUploadsAfterDays !== null || r.expireOnDate !== null, {
    message: 'a rule must delete files, or clear unfinished uploads, after some days',
  })
  .refine((r) => !(r.expireAfterDays !== null && r.expireOnDate !== null), {
    message: 'a rule deletes files after N days or on a date, not both',
  });
export type LifecycleRuleInput = z.input<typeof LifecycleRuleInput>;
export type LifecycleRuleView = z.output<typeof LifecycleRuleInput>;

/** `buckets.setLifecycle`. No rules ⇒ remove the bucket's lifecycle configuration. */
export const SetBucketLifecycleInput = z.object({
  bucketId: z.string().min(1),
  rules: z.array(LifecycleRuleInput).max(MAX_LIFECYCLE_RULES),
});
export type SetBucketLifecycleInput = z.infer<typeof SetBucketLifecycleInput>;

/** `buckets.getLifecycle`. */
export interface BucketLifecycleView {
  bucketId: string;
  bucket: string;
  rules: LifecycleRuleView[];
}

/** Give every unnamed rule a stable `swarmy-<n>` id that no other rule uses. Pure. */
export function nameLifecycleRules(rules: readonly LifecycleRuleView[]): LifecycleRuleView[] {
  const used = new Set(rules.map((r) => r.id).filter((id): id is string => id !== null));
  let n = 0;
  return rules.map((r) => {
    if (r.id !== null) return r;
    let id: string;
    do id = `swarmy-${++n}`;
    while (used.has(id));
    used.add(id);
    return { ...r, id };
  });
}
