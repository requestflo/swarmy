/**
 * Sentry wire protocol, ingest side (pure, no IO): body decompression, the
 * envelope format, the legacy `/store/` body and the three ways an SDK
 * authenticates. Existing Sentry SDKs talk to swarmy unchanged because this
 * file speaks exactly what they send — pinned by the real `@sentry/node`
 * payloads in `__fixtures__/`.
 *
 * Envelope (https://develop.sentry.dev/sdk/data-model/envelopes/):
 *
 *   Envelope    = Headers "\n" { Item } [ "\n" ]
 *   Item        = ItemHeaders "\n" Payload
 *   Payload     = exactly `length` bytes (then an optional "\n")
 *               | everything up to the next "\n" / EOF when `length` is absent
 *
 * Headers are single-line JSON. `length` counts BYTES (not UTF-16 units), so
 * everything here works on the raw `Uint8Array`.
 */
import * as zlib from 'node:zlib';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

/** Hard cap on a decompressed body (Sentry's own envelope ceiling is 200 MiB; ours is smaller). */
export const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;
/** Sentry's per-event item cap. Larger event payloads are dropped, not truncated. */
export const MAX_EVENT_ITEM_BYTES = 1024 * 1024;
/**
 * Decompression-bomb guard: a decoded layer may not exceed this multiple of
 * its compressed input (real JSON envelopes compress 5-20x). Bodies whose
 * decoded size stays under {@link RATIO_FLOOR_BYTES} are exempt, so tiny
 * highly-repetitive payloads still pass.
 */
export const MAX_DECOMPRESSION_RATIO = 100;
export const RATIO_FLOOR_BYTES = 1024 * 1024;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export interface EnvelopeItem {
  header: Record<string, unknown> & { type: string };
  payload: Uint8Array;
}

export interface Envelope {
  header: Record<string, unknown>;
  items: EnvelopeItem[];
}

const NL = 0x0a;
const decoder = new TextDecoder();

function parseJsonLine(bytes: Uint8Array, what: string): Record<string, unknown> {
  const text = decoder.decode(bytes).trim();
  if (!text) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new EnvelopeError(`${what} is not valid JSON`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new EnvelopeError(`${what} is not a JSON object`);
  return v as Record<string, unknown>;
}

function indexOfNl(buf: Uint8Array, from: number): number {
  const i = buf.indexOf(NL, from);
  return i === -1 ? buf.length : i;
}

/** Parse a (decompressed) envelope body. Throws {@link EnvelopeError} on a malformed one. */
export function parseEnvelope(body: Uint8Array): Envelope {
  let pos = 0;
  const headerEnd = indexOfNl(body, 0);
  const header = parseJsonLine(body.subarray(0, headerEnd), 'envelope header');
  pos = headerEnd + 1;
  const items: EnvelopeItem[] = [];

  while (pos < body.length) {
    const lineEnd = indexOfNl(body, pos);
    const line = body.subarray(pos, lineEnd);
    // Blank lines between items (and the optional trailing newline) are tolerated.
    if (decoder.decode(line).trim() === '') {
      pos = lineEnd + 1;
      continue;
    }
    const itemHeader = parseJsonLine(line, 'item header');
    if (typeof itemHeader.type !== 'string' || !itemHeader.type) {
      throw new EnvelopeError('item header has no type');
    }
    pos = lineEnd + 1;
    let payload: Uint8Array;
    const length = itemHeader.length;
    if (typeof length === 'number' && Number.isInteger(length) && length >= 0) {
      if (pos + length > body.length) throw new EnvelopeError('item payload is shorter than its length');
      payload = body.subarray(pos, pos + length);
      pos += length;
      if (body[pos] === NL) pos += 1;
    } else {
      const end = indexOfNl(body, pos);
      payload = body.subarray(pos, end);
      pos = end + 1;
    }
    items.push({ header: itemHeader as EnvelopeItem['header'], payload });
  }
  return { header, items };
}

/** Decode an item payload as a JSON object (events, transactions, sessions…). */
export function itemJson(item: EnvelopeItem): Record<string, unknown> | null {
  try {
    const v = JSON.parse(decoder.decode(item.payload)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Undo `Content-Encoding`. SDKs use gzip (Node/Python over 32 KiB), deflate
 * (older Python/Ruby), br and zstd (Relay-style tunnels). A body that starts
 * with the gzip magic is gunzipped even without the header (some proxies strip
 * it). Every codec (zstd included) is decoded with a hard output bound —
 * the decoder stops allocating at the bound instead of inflating a bomb and
 * checking afterwards: min({@link MAX_DECOMPRESSED_BYTES},
 * max({@link RATIO_FLOOR_BYTES}, input × {@link MAX_DECOMPRESSION_RATIO})).
 */
export function decodeBody(raw: Uint8Array, contentEncoding?: string | null): Uint8Array {
  const encodings = (contentEncoding ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'identity');
  let out: Uint8Array = raw;
  const bound = (input: Uint8Array) => ({
    maxOutputLength: Math.min(MAX_DECOMPRESSED_BYTES, Math.max(RATIO_FLOOR_BYTES, input.length * MAX_DECOMPRESSION_RATIO)),
  });
  try {
    // Encodings apply in order, so they are undone in reverse.
    for (const enc of encodings.reverse()) {
      const opts = bound(out);
      if (enc === 'gzip' || enc === 'x-gzip') out = gunzipSync(out, opts);
      else if (enc === 'deflate') {
        try {
          out = inflateSync(out, opts);
        } catch (e) {
          if (isTooLarge(e)) throw e;
          out = inflateRawSync(out, opts); // some clients send raw deflate
        }
      } else if (enc === 'br') out = brotliDecompressSync(out, opts);
      else if (enc === 'zstd') out = zstdDecompress(out, opts);
      else throw new EnvelopeError(`unsupported content-encoding ${enc}`);
    }
    if (!encodings.length && out.length > 2 && out[0] === 0x1f && out[1] === 0x8b) {
      out = gunzipSync(out, bound(out));
    }
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    if (isTooLarge(e)) throw new EnvelopeError('body too large');
    throw new EnvelopeError('body could not be decompressed');
  }
  if (out.length > MAX_DECOMPRESSED_BYTES) throw new EnvelopeError('body too large');
  return out;
}

/** node:zlib raises ERR_BUFFER_TOO_LARGE (RangeError) when `maxOutputLength` is hit. */
function isTooLarge(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError;
}

type ZstdSync = (b: Uint8Array, o: { maxOutputLength: number }) => Uint8Array;

/**
 * Bounded zstd: node:zlib's `zstdDecompressSync` honours `maxOutputLength`
 * (Bun ≥ 1.3 / Node ≥ 22.15). `Bun.zstdDecompressSync` has no bound, so it is
 * never used — without a bounded decoder zstd is refused.
 */
function zstdDecompress(buf: Uint8Array, opts: { maxOutputLength: number }): Uint8Array {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdSync }).zstdDecompressSync;
  if (typeof fn !== 'function') throw new EnvelopeError('unsupported content-encoding zstd');
  return fn(buf, opts);
}

/**
 * Legacy `/api/<id>/store/` body: a single JSON event. Very old SDKs (raven)
 * sent it base64 + zlib; handle that too.
 */
export function parseStoreBody(body: Uint8Array): Record<string, unknown> {
  const text = decoder.decode(body).trim();
  const tryJson = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = text.startsWith('{') ? tryJson(text) : null;
  if (direct) return direct;
  try {
    const inflated = inflateSync(Buffer.from(text, 'base64'), { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    const v = tryJson(decoder.decode(inflated));
    if (v) return v;
  } catch {
    // fall through
  }
  throw new EnvelopeError('store body is not a JSON event');
}

/* ----------------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------------- */

export interface SentryAuth {
  publicKey: string | null;
  /** Project id from the envelope `dsn` header, when the key came from there. */
  dsnProjectId?: string | null;
  client?: string | null;
}

/** `Sentry sentry_key=abc, sentry_version=7, sentry_client=x/1.0` → fields. */
export function parseAuthHeader(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  const body = value.replace(/^\s*sentry\s+/i, '');
  const out: Record<string, string> = {};
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** The public key from a DSN (`https://<key>@host/<project>`), plus its project id. */
export function parseDsnKey(dsn: string): { publicKey: string; projectId: string } | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (!u.username || !/^\d+$/.test(projectId)) return null;
    return { publicKey: decodeURIComponent(u.username), projectId };
  } catch {
    return null;
  }
}

/**
 * Resolve the presented public key: `X-Sentry-Auth` (server SDKs) →
 * `?sentry_key=` (browser SDKs, which can't set headers on a beacon) →
 * the envelope's own `dsn` header (tunnels). First match wins.
 */
export function resolveAuth(opts: {
  authHeader?: string | null;
  query?: URLSearchParams;
  envelopeHeader?: Record<string, unknown>;
}): SentryAuth {
  const h = parseAuthHeader(opts.authHeader);
  if (h.sentry_key) return { publicKey: h.sentry_key, client: h.sentry_client ?? null };
  const q = opts.query?.get('sentry_key');
  if (q) return { publicKey: q, client: opts.query?.get('sentry_client') ?? null };
  const dsn = opts.envelopeHeader?.dsn;
  if (typeof dsn === 'string') {
    const parsed = parseDsnKey(dsn);
    if (parsed) return { publicKey: parsed.publicKey, dsnProjectId: parsed.projectId };
  }
  return { publicKey: null };
}

/* ----------------------------------------------------------------------------
 * Responses
 * ------------------------------------------------------------------------- */

/** Item types swarmy stores today. Everything else is accepted and dropped (SDKs must not retry). */
export const STORED_ITEM_TYPES = ['event'] as const;

/**
 * `X-Sentry-Rate-Limits` value for a 429: `<retry_after>:<categories>:<scope>`.
 * An empty category list means "every category".
 */
export function rateLimitHeader(retryAfterSeconds: number, categories: string[] = []): string {
  return `${Math.max(1, Math.ceil(retryAfterSeconds))}:${categories.join(';')}:key`;
}
