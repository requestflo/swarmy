/**
 * The AI gateway's answer cache, per route (opt-in) and per virtual key.
 * PURE and browser-safe: the route settings codec, the prompt normaliser the
 * cache keys come from, vector maths, the stats view and the in-process seam
 * the dashboard reads stats through. The store itself (process memory, TTL,
 * LRU) lives in apps/api `ai/route-cache.ts`.
 *
 * Two tiers, both non-streaming chat/messages only:
 *   1. same question — the normalised conversation + every parameter that
 *      changes the answer hash to one key (whitespace and JSON key order don't
 *      count; case, punctuation and indentation do);
 *   2. similar question (when the route sets `similarity` and the org's
 *      `embed` route resolves) — same conversation so far and parameters, and
 *      the last user message's embedding is within the cosine threshold.
 */

/** A route's cache setting (`AiConfigDoc.routeCache[route]`). */
export interface AiRouteCache {
  /** How long a stored answer is served, in seconds. */
  ttlSeconds: number;
  /** Cosine threshold for a similar-question hit via `embed`; null = same question only. */
  similarity: number | null;
}

export const ROUTE_CACHE_TTL = { min: 60, max: 7 * 86_400, default: 3_600 } as const;
export const ROUTE_CACHE_SIMILARITY = { min: 0.8, max: 0.999, default: 0.95 } as const;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Parse one setting; null when it isn't a usable object. */
export function parseRouteCache(raw: unknown): AiRouteCache | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { ttlSeconds?: unknown; similarity?: unknown };
  const ttl = typeof o.ttlSeconds === 'number' && Number.isFinite(o.ttlSeconds) ? Math.round(o.ttlSeconds) : ROUTE_CACHE_TTL.default;
  const sim = typeof o.similarity === 'number' && Number.isFinite(o.similarity) ? o.similarity : null;
  return {
    ttlSeconds: clamp(ttl, ROUTE_CACHE_TTL.min, ROUTE_CACHE_TTL.max),
    similarity: sim === null ? null : clamp(sim, ROUTE_CACHE_SIMILARITY.min, ROUTE_CACHE_SIMILARITY.max),
  };
}

/** Body fields that never change the answer. */
const IGNORED = new Set(['stream', 'stream_options', 'user', 'metadata', 'messages', 'system']);

/** Line endings, NFKC, trailing spaces, inner runs of spaces. Indentation stays. */
export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/(\S)[ \t]+(?=\S)/g, '$1 ').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Content as the cache sees it: text normalised, other parts (images, tool results) verbatim. */
function normaliseContent(c: unknown): unknown {
  if (typeof c === 'string') return normaliseText(c);
  if (!Array.isArray(c)) return c ?? null;
  return c.map((part) => {
    const p = part as { type?: unknown; text?: unknown };
    return p && typeof p.text === 'string' && (p.type === 'text' || p.type === undefined) ? { type: 'text', text: normaliseText(p.text) } : part;
  });
}

/** The last message's text when it is a plain user question (no images/tool parts). */
function questionText(m: { role?: unknown; content?: unknown }): string | null {
  if (m.role !== 'user') return null;
  if (typeof m.content === 'string') return m.content || null;
  if (!Array.isArray(m.content)) return null;
  const parts = m.content as Array<{ type?: unknown; text?: unknown }>;
  if (!parts.every((p) => p && typeof p.text === 'string' && (p.type === 'text' || p.type === undefined))) return null;
  return parts.map((p) => p.text as string).join('\n') || null;
}

export interface AiCacheKeyParts {
  /** The whole request, normalised: equal ⇔ same question. */
  exact: string;
  /** Everything but the last user message: equal ⇔ same conversation so far. */
  context: string;
  /** The last user message (normalised), or null when similarity can't apply. */
  question: string | null;
}

/** PURE — cache key material for a chat/messages body; null when it has no messages. */
export function cacheKeyParts(body: Record<string, unknown>): AiCacheKeyParts | null {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  const messages = (body.messages as Array<Record<string, unknown>>).map((m) =>
    m && typeof m === 'object' ? { ...m, content: normaliseContent(m.content) } : m,
  );
  const params = Object.fromEntries(Object.entries(body).filter(([k]) => !IGNORED.has(k)));
  const system = normaliseContent(body.system);
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown };
  return {
    exact: canonical({ params, system, messages }),
    context: canonical({ params, system, messages: messages.slice(0, -1), role: last?.role ?? null }),
    question: last ? questionText(last) : null,
  };
}

/** Unit-length copy of an embedding (cosine = dot product); null when empty/zero. */
export function unitVector(v: readonly number[]): Float32Array | null {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!v.length || !Number.isFinite(norm) || norm === 0) return null;
  return Float32Array.from(v, (x) => x / norm);
}

/** Cosine of two unit vectors; -1 when the dimensions differ (another embed model). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
