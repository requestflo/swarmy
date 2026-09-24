/**
 * AWS Signature Version 4 for the Bedrock runtime (service `bedrock`).
 * Pure over an injectable clock so the golden test pins a signature.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The stored Bedrock credential: `ACCESS_KEY_ID:SECRET[:SESSION_TOKEN]`, or a
 * Bedrock API key (no colon) used as a bearer token.
 */
export function parseAwsCredential(raw: string): { kind: 'sigv4'; creds: AwsCredentials } | { kind: 'bearer'; token: string } {
  const parts = raw.trim().split(':');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return {
      kind: 'sigv4',
      creds: { accessKeyId: parts[0], secretAccessKey: parts[1], ...(parts[2] ? { sessionToken: parts.slice(2).join(':') } : {}) },
    };
  }
  return { kind: 'bearer', token: raw.trim() };
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string): Buffer => createHmac('sha256', key).update(s, 'utf8').digest();

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent + !'()*). */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  creds: AwsCredentials;
  now?: Date;
  /** Send + sign `x-amz-content-sha256` (default true; the AWS test suite vectors omit it). */
  contentSha256Header?: boolean;
}

/**
 * Returns the headers to send (input headers + host, x-amz-date,
 * x-amz-content-sha256, [x-amz-security-token], authorization). Non-S3
 * services double-encode each path segment in the canonical URI.
 */
export function signV4(i: SignInput): Record<string, string> {
  const u = new URL(i.url);
  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(i.body);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim();
  headers.host = u.host;
  headers['x-amz-date'] = amzDate;
  if (i.contentSha256Header !== false) headers['x-amz-content-sha256'] = payloadHash;
  if (i.creds.sessionToken) headers['x-amz-security-token'] = i.creds.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri =
    u.pathname
      .split('/')
      .map((seg) => uriEncode(seg))
      .join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [i.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${i.creds.secretAccessKey}`, date);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, i.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
