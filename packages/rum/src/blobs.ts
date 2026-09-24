import { createHash, createHmac } from 'node:crypto';

/**
 * Replay chunk storage in swarmy object storage (Garage, S3 API). A minimal
 * SigV4 client over fetch: PUT / GET / DELETE / ListObjectsV2 — the only
 * calls the replay path needs. Path-style addressing (Garage serves nothing
 * else).
 *
 * Key layout (day-partitioned so retention deletes whole day prefixes):
 *   rum/<orgId>/<app>/<YYYY-MM-DD>/<sessionId>/<seq:6>.json.gz
 */
export const RUM_REPLAY_BUCKET = 'swarmy-rum-replays';

export function replayChunkKey(orgId: string, app: string, day: string, sessionId: string, seq: number): string {
  return `${replaySessionPrefix(orgId, app, day, sessionId)}${String(seq).padStart(6, '0')}.json.gz`;
}

export function replaySessionPrefix(orgId: string, app: string, day: string, sessionId: string): string {
  return `${replayAppPrefix(orgId, app)}${day}/${sessionId}/`;
}

export function replayAppPrefix(orgId: string, app: string): string {
  return `${replayOrgPrefix(orgId)}${encodeSeg(app)}/`;
}

export function replayOrgPrefix(orgId: string): string {
  return `rum/${encodeSeg(orgId)}/`;
}

function encodeSeg(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Day prefixes (YYYY-MM-DD) strictly older than the retention window. */
export function expiredDays(days: readonly string[], retentionDays: number, now: Date): string[] {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  return days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff).sort();
}

export interface S3Coordinates {
  endpoint: string; // http://swarmy-garage:3900
  region: string; // garage
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();

function uriEncode(s: string, encodeSlash: boolean): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, encodeSlash ? '%2F' : '/');
}

/** Sign one request (AWS SigV4, header auth). Pure given `now`. Exported for tests. */
export function signS3Request(
  c: S3Coordinates,
  req: { method: string; key: string; query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> },
  now: Date,
): { url: string; headers: Record<string, string> } {
  const base = new URL(c.endpoint);
  const path = `/${uriEncode(c.bucket, true)}${req.key ? `/${uriEncode(req.key, false)}` : ''}`;
  const q = Object.entries(req.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = q.map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`).join('&');
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(req.body ?? new Uint8Array());
  const headers: Record<string, string> = {
    host: base.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [req.method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${c.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, c.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  const { host: _h, ...rest } = headers;
  return {
    url: `${base.origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      ...rest,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export interface BlobStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Keys (or common prefixes when `delimiter` is set) under a prefix. */
  list(prefix: string, delimiter?: string): Promise<{ keys: string[]; prefixes: string[] }>;
}

/** S3 BlobStore over fetch. */
export function s3BlobStore(c: S3Coordinates, fetchImpl: typeof fetch = fetch): BlobStore {
  async function call(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const signed = signS3Request(c, { method, key, ...opts }, new Date());
    return fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      body: opts.body ? (Buffer.from(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength) as unknown as ArrayBuffer) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  }
  return {
    async put(key, body, contentType = 'application/gzip') {
      const res = await call('PUT', key, { body, headers: { 'content-type': contentType } });
      if (!res.ok) throw new Error(`object store PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`object store GET ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await call('DELETE', key);
      if (!res.ok && res.status !== 404) throw new Error(`object store DELETE ${res.status}`);
    },
    async list(prefix, delimiter) {
      const keys: string[] = [];
      const prefixes: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const query: Record<string, string> = { 'list-type': '2', prefix };
        if (delimiter) query.delimiter = delimiter;
        if (token) query['continuation-token'] = token;
        const res = await call('GET', '', { query });
        if (!res.ok) throw new Error(`object store LIST ${res.status}`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlUnescape(m[1]!));
        for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) prefixes.push(xmlUnescape(m[1]!));
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
        if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = xmlUnescape(next);
      }
      return { keys, prefixes };
    },
  };
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Delete every object under a prefix. Returns how many were removed. */
export async function deletePrefix(store: BlobStore, prefix: string): Promise<number> {
  const { keys } = await store.list(prefix);
  for (const k of keys) await store.delete(k);
  return keys.length;
}

/** In-memory BlobStore for tests. */
export function memoryBlobStore(): BlobStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix, delimiter) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (!delimiter) return { keys, prefixes: [] };
      const prefixes = new Set<string>();
      const direct: string[] = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1));
        else direct.push(k);
      }
      return { keys: direct, prefixes: [...prefixes].sort() };
    },
  };
}
