/**
 * S3 `CORSConfiguration` documents for Garage — build (PutBucketCors) and
 * parse (GetBucketCors). One `<CORSRule>` per origin, so Garage v1 (which
 * echoes a rule's whole origin list) still answers each browser with exactly
 * its own origin. Elements are written in Garage's struct order. Pure.
 */
import { CORS_ALLOWED_HEADERS, CORS_EXPOSE_HEADERS, type CorsRuleView } from '@swarmy/core';
import { el, xmlAll, xmlInt, xmlTexts } from './s3-xml';

export const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

export interface CorsPolicy {
  origins: readonly string[];
  methods: readonly string[];
  maxAgeSeconds: number | null;
}

/** The rules swarmy stores for a policy: one per origin, same methods/headers/max-age. */
export function corsRulesFor(policy: CorsPolicy): CorsRuleView[] {
  return policy.origins.map((origin) => ({
    origins: [origin],
    methods: [...policy.methods],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposeHeaders: [...CORS_EXPOSE_HEADERS],
    maxAgeSeconds: policy.maxAgeSeconds,
  }));
}

export function buildCorsXml(policy: CorsPolicy): string {
  const rules = corsRulesFor(policy).map((r, i) =>
    [
      '<CORSRule>',
      el('ID', `swarmy-${i + 1}`),
      r.maxAgeSeconds !== null ? el('MaxAgeSeconds', r.maxAgeSeconds) : '',
      ...r.origins.map((o) => el('AllowedOrigin', o)),
      ...r.methods.map((m) => el('AllowedMethod', m)),
      ...r.allowedHeaders.map((h) => el('AllowedHeader', h)),
      ...r.exposeHeaders.map((h) => el('ExposeHeader', h)),
      '</CORSRule>',
    ].join(''),
  );
  return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="${S3_XMLNS}">${rules.join('')}</CORSConfiguration>`;
}

/** GetBucketCors body → rules (empty body / no rules ⇒ []). */
export function parseCorsXml(xml: string): CorsRuleView[] {
  return xmlAll(xml, 'CORSRule').map((r) => ({
    origins: xmlTexts(r, 'AllowedOrigin'),
    methods: xmlTexts(r, 'AllowedMethod'),
    allowedHeaders: xmlTexts(r, 'AllowedHeader'),
    exposeHeaders: xmlTexts(r, 'ExposeHeader'),
    maxAgeSeconds: xmlInt(r, 'MaxAgeSeconds'),
  }));
}
