/**
 * Bucket CORS — which websites a browser may load a bucket's files from
 * directly (S3 PutBucketCors on Garage). Shared by the controller (validation,
 * the view) and the dashboard (inline validation, the Code view). Pure.
 *
 * Garage facts this module encodes (checked against the v1.0.1 and v2.4.1
 * sources, `api/common/cors.rs`):
 *  - an origin matches exactly, or `*` matches any; v2 also matches ONE `*`
 *    inside a pattern (`https://*.example.com`), v1 does not;
 *  - v1 answers `Access-Control-Allow-Origin` with every origin of the rule
 *    joined by commas, which browsers reject — so swarmy writes one rule per
 *    origin, and the browser always sees exactly its own origin back.
 */
import { z } from 'zod';

/** Methods a rule may allow (what browsers send to S3). */
export const CORS_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'] as const;
export type CorsMethod = (typeof CORS_METHODS)[number];

/** At most this many origins per bucket (one Garage rule each). */
export const MAX_CORS_ORIGINS = 20;
/** Longest preflight cache swarmy offers: a day (browsers cap lower anyway). */
export const MAX_CORS_MAX_AGE = 86_400;

/** Headers swarmy always allows / exposes: any request header, and ETag for multipart uploads. */
export const CORS_ALLOWED_HEADERS = ['*'] as const;
export const CORS_EXPOSE_HEADERS = ['ETag'] as const;

const EXACT = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const SUBDOMAIN_WILDCARD = /^https?:\/\/\*(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

export type OriginCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Validate and normalise one origin (`https://shop.example.com`, `*`, and on
 * Garage v2 `https://*.example.com`). Lower-cases, trims, drops a trailing `/`.
 */
export function checkCorsOrigin(raw: string, opts: { wildcards: boolean }): OriginCheck {
  const o = raw.trim().toLowerCase().replace(/\/+$/, '');
  if (o === '*') return { ok: true, origin: '*' };
  if (EXACT.test(o)) return { ok: true, origin: o };
  if (SUBDOMAIN_WILDCARD.test(o)) {
    return opts.wildcards
      ? { ok: true, origin: o }
      : { ok: false, reason: `"${raw.trim()}": this store's engine (Garage v1) matches origins exactly — list each site, or upgrade the engine` };
  }
  return { ok: false, reason: `"${raw.trim()}" isn't an origin — use scheme and host only, like https://shop.example.com` };
}

/** Whether an origin is a developer's machine (shown as "dev"). */
export function isDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

/** `buckets.setCors`. No origins ⇒ remove the bucket's CORS rules. */
export const SetBucketCorsInput = z.object({
  bucketId: z.string().min(1),
  origins: z.array(z.string().min(1).max(300)).max(MAX_CORS_ORIGINS),
  methods: z.array(z.enum(CORS_METHODS)).max(CORS_METHODS.length).default(['GET', 'HEAD']),
  /** Preflight cache in seconds; null = no Access-Control-Max-Age (browser default). */
  maxAgeSeconds: z.number().int().min(0).max(MAX_CORS_MAX_AGE).nullable().default(3600),
});
export type SetBucketCorsInput = z.infer<typeof SetBucketCorsInput>;

/** One stored rule, as Garage returns it. */
export interface CorsRuleView {
  origins: string[];
  methods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number | null;
}

/** `buckets.getCors`: the rules, folded into the one policy the page edits. */
export interface BucketCorsView {
  bucketId: string;
  bucket: string;
  origins: string[];
  methods: string[];
  maxAgeSeconds: number | null;
  /** False when the stored rules differ from each other (set outside swarmy); saving replaces them. */
  uniform: boolean;
  /** The engine matches `https://*.example.com` patterns (Garage v2+). */
  wildcards: boolean;
  rules: CorsRuleView[];
}

/** Fold stored rules into one origins/methods/max-age policy. Pure. */
export function foldCorsRules(rules: readonly CorsRuleView[]): Pick<BucketCorsView, 'origins' | 'methods' | 'maxAgeSeconds' | 'uniform'> {
  const origins = [...new Set(rules.flatMap((r) => r.origins))];
  const methods = CORS_METHODS.filter((m) => rules.some((r) => r.methods.includes(m) || r.methods.includes('*')));
  const sig = (r: CorsRuleView) => JSON.stringify([[...r.methods].sort(), r.maxAgeSeconds, [...r.allowedHeaders].sort()]);
  const uniform = rules.every((r) => sig(r) === sig(rules[0]!));
  const maxAgeSeconds = rules.length ? (rules[0]!.maxAgeSeconds ?? null) : null;
  return { origins, methods, maxAgeSeconds, uniform };
}

/** Stored rules in the S3 JSON shape (`aws s3api get-bucket-cors`, the Code view). Pure. */
export function corsRulesJson(rules: readonly CorsRuleView[]): Array<Record<string, unknown>> {
  return rules.map((r) => ({
    AllowedOrigins: r.origins,
    AllowedMethods: r.methods,
    ...(r.allowedHeaders.length ? { AllowedHeaders: r.allowedHeaders } : {}),
    ...(r.exposeHeaders.length ? { ExposeHeaders: r.exposeHeaders } : {}),
    ...(r.maxAgeSeconds !== null ? { MaxAgeSeconds: r.maxAgeSeconds } : {}),
  }));
}
