/**
 * Per request: does the route's answer cache apply, under which keys, and
 * was there a stored answer? The gateway (ai-gateway.ts) supplies the embed
 * call; everything here is deterministic given it.
 */
import { createHash } from 'node:crypto';
import { cacheKeyParts, type AiRouteCache } from '@swarmy/core/views';
import type { CacheScope, RouteCache } from './route-cache';

export interface RouteCachePlan {
  scope: CacheScope;
  /** sha-256 of the normalised request (+ path: chat and messages answer in different shapes). */
  exact: string;
  /** sha-256 of the conversation before the last user message. */
  context: string;
  /** The question to embed; null = same-question matching only. */
  question: string | null;
  ttlMs: number;
  similarity: number | null;
}

export interface PlanInput {
  orgId: string;
  keyId: string;
  /** The route (alias) the request named; a bare model id has no route cache. */
  route: string | null;
  path: string;
  op: 'chat' | 'embeddings' | 'messages';
  stream: boolean;
  body: Record<string, unknown>;
  settings: Readonly<Record<string, AiRouteCache>>;
  /** Whether the org's `embed` route resolves (similar-question matching needs it). */
  canEmbed: boolean;
}

/** PURE apart from hashing — the cache plan for one request, or null when it doesn't apply. */
export function planRouteCache(i: PlanInput): RouteCachePlan | null {
  if (!i.route || i.stream || i.op === 'embeddings') return null;
  const cfg = i.settings[i.route];
  if (!cfg) return null;
  const parts = cacheKeyParts(i.body);
  if (!parts) return null;
  const h = (s: string): string => createHash('sha256').update(`${i.path}\n${s}`).digest('hex');
  return {
    scope: { orgId: i.orgId, route: i.route, keyId: i.keyId },
    exact: h(parts.exact),
    context: h(parts.context),
    question: cfg.similarity !== null && i.canEmbed ? parts.question : null,
    ttlMs: cfg.ttlSeconds * 1000,
    similarity: cfg.similarity,
  };
}

export interface CacheHit<V> {
  value: V;
  kind: 'same' | 'similar';
  /** Cosine similarity of a similar-question hit. */
  score: number | null;
}

export interface CacheLookup<V> {
  hit: CacheHit<V> | null;
  /** The question's embedding, kept for storing the answer on a miss (one embed call per request). */
  vector: Float32Array | null;
}

/**
 * Same question first; then, when the route asks for it, embed the question
 * and look for a similar one. Counts the lookup, the hit and what it saved.
 */
export async function lookupRouteCache<V>(
  cache: RouteCache<V>,
  plan: RouteCachePlan,
  deps: { embed: (text: string) => Promise<Float32Array | null>; savedMicros: (v: V) => number },
  now = Date.now(),
): Promise<CacheLookup<V>> {
  cache.count(plan.scope, 'lookup');
  const same = cache.same(plan.scope, plan.exact, plan.ttlMs, now);
  if (same) {
    cache.count(plan.scope, 'same', deps.savedMicros(same));
    return { hit: { value: same, kind: 'same', score: null }, vector: null };
  }
  if (plan.similarity === null || !plan.question) return { hit: null, vector: null };
  const vector = await deps.embed(plan.question).catch(() => null);
  if (!vector) {
    cache.count(plan.scope, 'embedError');
    return { hit: null, vector: null };
  }
  const sim = cache.similar(plan.scope, plan.context, vector, plan.similarity, plan.ttlMs, now);
  if (!sim) return { hit: null, vector };
  cache.count(plan.scope, 'similar', deps.savedMicros(sim.value));
  return { hit: { value: sim.value, kind: 'similar', score: sim.score }, vector };
}

/** Store an answer under the plan's keys (with the question's embedding when there is one). */
export function storeRouteCache<V>(cache: RouteCache<V>, plan: RouteCachePlan, vector: Float32Array | null, value: V, now = Date.now()): void {
  cache.set(plan.scope, plan.exact, plan.context, vector, value, plan.ttlMs, now);
}
