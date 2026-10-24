/**
 * "What happens to files as they age" (a bucket's lifecycle rules): the age
 * axis, each rule's words, the sentence and the Code view text. Pure —
 * mirrors `@swarmy/core` bucket-lifecycle (Garage: expiry + unfinished-upload
 * clean-up, by prefix).
 */
import type { LifecycleRuleView } from '@swarmy/core';

/** The axis marks on board 42: upload · 7 d · 30 d · 1 y · forever. */
export const AGE_MARKS: Array<{ label: string; at: number }> = [
  { label: 'upload', at: 0 },
  { label: '7 d', at: 25 },
  { label: '30 d', at: 50 },
  { label: '1 y', at: 75 },
  { label: 'forever', at: 100 },
];

const STOPS: Array<[days: number, at: number]> = [[7, 25], [30, 50], [365, 75], [3650, 95]];

/** Where an age sits on the axis (0–100), log-spaced between the marks; null = forever. */
export function agePosition(days: number | null): number {
  if (days === null) return 100;
  if (days <= 0) return 0;
  if (days <= 7) return (25 * Math.log(1 + days)) / Math.log(8);
  for (let i = 1; i < STOPS.length; i++) {
    const [d0, a0] = STOPS[i - 1]!;
    const [d1, a1] = STOPS[i]!;
    if (days <= d1) return a0 + ((a1 - a0) * Math.log(days / d0)) / Math.log(d1 / d0);
  }
  return 95;
}

/** 1 → "1 day", 30 → "30 days", 365 → "1 year", 730 → "2 years". */
export function fmtDays(d: number): string {
  if (d >= 365 && d % 365 === 0) return d === 365 ? '1 year' : `${d / 365} years`;
  return d === 1 ? '1 day' : `${d} days`;
}

/** Which files a rule covers, in plain words. */
export function ruleWhere(r: Pick<LifecycleRuleView, 'prefix'>): string {
  return r.prefix ? `files under ${r.prefix}` : 'all files';
}

/** What a rule does ("deleted after 30 days · unfinished uploads cleared after 7 days"). */
export function ruleDoes(r: LifecycleRuleView): string {
  const parts = [
    r.expireAfterDays !== null ? `deleted after ${fmtDays(r.expireAfterDays)}` : r.expireOnDate ? `deleted on ${r.expireOnDate.slice(0, 10)}` : '',
    r.abortUploadsAfterDays !== null ? `unfinished uploads cleared after ${fmtDays(r.abortUploadsAfterDays)}` : '',
  ].filter(Boolean);
  return `${parts.join(' · ')}${r.enabled ? '' : ' (paused)'}`;
}

/** The lede: what ages out, and what stays. */
export function lifeSay(rules: readonly LifecycleRuleView[]): string {
  const live = rules.filter((r) => r.enabled);
  const deleting = live.filter((r) => r.expireAfterDays !== null || r.expireOnDate !== null);
  const uploads = live.some((r) => r.abortUploadsAfterDays !== null) ? ' Unfinished uploads are cleared.' : '';
  if (deleting.length === 0) return `Files stay until someone deletes them.${uploads}`;
  const lines = deleting.map(
    (r) => `${ruleWhere(r)} ${r.expireAfterDays !== null ? `are deleted after ${fmtDays(r.expireAfterDays)}` : `are deleted on ${r.expireOnDate!.slice(0, 10)}`}`,
  );
  const sentence = `${lines.join('; ')}.`;
  const whole = deleting.some((r) => !r.prefix && r.sizeGreaterThan === null && r.sizeLessThan === null);
  const rest = whole ? '' : ' Everything else stays until someone deletes it.';
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${rest}${uploads}`;
}

/** The rules as S3 JSON (`aws s3api get-bucket-lifecycle-configuration`) and the matching CLI call. */
export function lifecycleCode(input: { bucket: string; endpoint: string; rules: readonly LifecycleRuleView[] }): Array<{ label: string; code: string }> {
  const Rules = input.rules.map((r) => {
    const conds = { ...(r.prefix ? { Prefix: r.prefix } : {}), ...(r.sizeGreaterThan !== null ? { ObjectSizeGreaterThan: r.sizeGreaterThan } : {}), ...(r.sizeLessThan !== null ? { ObjectSizeLessThan: r.sizeLessThan } : {}) };
    return {
      ID: r.id,
      Status: r.enabled ? 'Enabled' : 'Disabled',
      Filter: Object.keys(conds).length > 1 ? { And: conds } : conds,
      ...(r.expireAfterDays !== null ? { Expiration: { Days: r.expireAfterDays } } : r.expireOnDate ? { Expiration: { Date: r.expireOnDate } } : {}),
      ...(r.abortUploadsAfterDays !== null ? { AbortIncompleteMultipartUpload: { DaysAfterInitiation: r.abortUploadsAfterDays } } : {}),
    };
  });
  const cli = Rules.length
    ? `aws s3api put-bucket-lifecycle-configuration --bucket ${input.bucket} \\\n  --endpoint-url ${input.endpoint} \\\n  --lifecycle-configuration '${JSON.stringify({ Rules })}'`
    : `aws s3api delete-bucket-lifecycle --bucket ${input.bucket} --endpoint-url ${input.endpoint}`;
  return [
    { label: 'Lifecycle JSON', code: JSON.stringify({ Rules }, null, 2) },
    { label: 'AWS CLI', code: `# needs a key with write on ${input.bucket}\n${cli}` },
  ];
}
