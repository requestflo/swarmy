/**
 * Pure AWS Signature V4 query presigner (WS5 — Garage lifecycle).
 *
 * No SDK, no IO, no clock: the timestamp is INJECTED (`now`) so the function is
 * deterministic and golden-testable against the AWS-documented known-answer
 * vector (see s3-presign.test.ts). Used by `buckets.service#presignObjectUrl`
 * to mint time-limited GET/PUT links against the in-swarm Garage S3 endpoint —
 * Garage implements standard SigV4, so the AWS algorithm applies verbatim.
 */
import { createHash, createHmac } from 'node:crypto';

/** S3's hard cap on presigned-URL lifetime: 7 days. */
export const MAX_PRESIGN_EXPIRES_SECONDS = 604_800;

export interface PresignS3Input {
  /** S3 endpoint origin, e.g. `http://swarmy-garage:3900`. */
  endpoint: string;
  region: string;
  /**
   * Bucket for a path-style URL (`/<bucket>/<key>`). Empty string = the
   * endpoint already addresses the bucket (virtual-hosted style).
   */
  bucket: string;
  /** Object key (may contain `/` — segments are encoded individually). */
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  method: 'GET' | 'PUT';
  /** 1..604800 (7 days) — the SigV4 presign limit. */
  expiresSeconds: number;
  /** Signing time — injected for determinism; callers pass `new Date()`. */
  now: Date;
}

/** RFC 3986 encode (AWS uri-encode): everything but A-Za-z0-9 `-._~`. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Canonical URI: each path segment encoded, `/` preserved. */
function canonicalPath(bucket: string, key: string): string {
  const segments = [...(bucket ? [bucket] : []), ...key.split('/')];
  return `/${segments.map(uriEncode).join('/')}`;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `YYYYMMDDTHHMMSSZ` from a Date (UTC). */
export function amzTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a presigned S3 URL (SigV4 query auth, UNSIGNED-PAYLOAD, host-only
 * signed headers — the standard browser-shareable form).
 */
export function presignS3Url(input: PresignS3Input): string {
  if (
    !Number.isInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > MAX_PRESIGN_EXPIRES_SECONDS
  ) {
    throw new RangeError(`expiresSeconds must be an integer in 1..${MAX_PRESIGN_EXPIRES_SECONDS}`);
  }
  const url = new URL(input.endpoint);
  const amzDate = amzTimestamp(input.now);
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${input.region}/s3/aws4_request`;
  const path = canonicalPath(input.bucket, input.key);

  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    `host:${url.host}\n`, // canonical headers block (trailing \n per header)
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, shortDate);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
