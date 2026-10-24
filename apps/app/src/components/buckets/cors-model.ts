/**
 * "Browsers allowed to fetch directly" (a bucket's CORS rules): the sentence,
 * the labels and the Code view text. Pure — mirrors `@swarmy/core`
 * bucket-cors and what `buckets.setCors` writes (one rule per origin).
 */
import { corsRulesJson, isDevOrigin, type CorsRuleView } from '@swarmy/core';
import type { ReachMode } from './reach-model';

export const MAX_AGE_OPTIONS: Array<{ value: string; seconds: number | null; label: string }> = [
  { value: 'off', seconds: null, label: 'Don’t cache' },
  { value: '600', seconds: 600, label: '10 minutes' },
  { value: '3600', seconds: 3600, label: '1 hour' },
  { value: '86400', seconds: 86_400, label: '1 day' },
];

export function maxAgeLabel(seconds: number | null): string {
  const hit = MAX_AGE_OPTIONS.find((o) => o.seconds === seconds);
  if (hit) return seconds === null ? 'not cached' : hit.label;
  return `${seconds}s`;
}

/** A browser PUT only works with a signed upload link; say so next to it. */
export function methodLabel(m: string): string {
  return m === 'PUT' ? 'PUT (presigned)' : m;
}

/** "3 sites can load files from it directly." — plus why it doesn't work yet when nothing outside can reach it. */
export function corsSay(origins: readonly string[], mode: ReachMode | undefined): string {
  if (origins.length === 0) return 'No website loads files from it directly; your apps fetch them on the server.';
  const sites = origins.includes('*')
    ? 'Any website'
    : `${origins.length} site${origins.length === 1 ? '' : 's'}${origins.some(isDevOrigin) ? ' (one on a laptop)' : ''}`;
  const tail = mode === 'INTERNAL' ? ' Browsers can’t reach this bucket yet: change who can reach it first.' : '';
  return `${sites} can load files from it straight in the browser.${tail}`;
}

/** Pretty JSON with short arrays of plain values kept on one line (`["GET", "HEAD"]`). */
export function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\[\n\s+([^[\]{}]*?)\n\s*\]/g, (_, inner: string) => `[${inner.split(/,\n\s*/).join(', ')}]`);
}

/** The Code view: the stored rules as S3 JSON, and the equivalent AWS CLI call. */
export function corsCode(input: { bucket: string; endpoint: string; rules: readonly CorsRuleView[] }): Array<{ label: string; code: string }> {
  const rules = corsRulesJson(input.rules);
  const cli = rules.length
    ? [
        `aws s3api put-bucket-cors --bucket ${input.bucket} \\`,
        `  --endpoint-url ${input.endpoint} \\`,
        `  --cors-configuration '${JSON.stringify({ CORSRules: rules })}'`,
      ].join('\n')
    : `aws s3api delete-bucket-cors --bucket ${input.bucket} --endpoint-url ${input.endpoint}`;
  return [
    { label: 'CORS JSON', code: compactJson(rules) },
    { label: 'AWS CLI', code: `# needs a key with owner on ${input.bucket}\n${cli}` },
  ];
}
