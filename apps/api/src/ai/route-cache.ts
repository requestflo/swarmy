/**
 * The answer cache's store: process memory only. Cached prompts and answers
 * are sensitive and short-lived — run state, never the store, a label or a
 * swarm config (docker-native-storage). Bounded three ways: a TTL per route
 * (checked on read, swept once a minute), a byte budget with global LRU
 * eviction, and a per-scope cap that bounds the similarity scan. A scope is
 * one org + route + virtual key: one app never sees another's answers.
 */
import { cosine, type AiCacheStatsView, type AiRouteCacheStatsView } from '@swarmy/core/views';

export interface CacheScope {
  orgId: string;
  route: string;
  keyId: string;
}

interface Entry<V> {
  scope: string;
  context: string;
  vector: Float32Array | null;
  value: V;
  at: number;
  expiresAt: number;
  bytes: number;
}

type Counters = Omit<AiRouteCacheStatsView, 'route' | 'entries' | 'savedUsd'> & { savedMicros: number };

const SWEEP_MS = 60_000;
const sk = (s: CacheScope): string => `${s.orgId}\u0000${s.route}\u0000${s.keyId}`;
const orgRoute = (s: CacheScope): string => `${s.orgId}\u0000${s.route}`;

export class RouteCache<V> {
  private entries = new Map<string, Entry<V>>();
  private byScope = new Map<string, Set<string>>();
  private counters = new Map<string, Counters>();
  private used = 0;
  private lastSweep = 0;
  readonly since = new Date();

  constructor(
    private readonly sizeOf: (v: V) => number,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxPerScope = 256,
  ) {}

  /** Same question: the entry stored under this exact key, if still fresh. */
  same(scope: CacheScope, exact: string, ttlMs: number, now = Date.now()): V | null {
    const id = `${sk(scope)}\u0000${exact}`;
    const e = this.entries.get(id);
    if (!e) return null;
    if (!this.fresh(e, ttlMs, now)) {
      this.drop(id);
      return null;
    }
    this.touch(id, e);
    return e.value;
  }

  /** Similar question: the closest fresh entry with the same context at or above `threshold`. */
  similar(scope: CacheScope, context: string, vector: Float32Array, threshold: number, ttlMs: number, now = Date.now()): { value: V; score: number } | null {
    let best: { id: string; e: Entry<V>; score: number } | null = null;
    for (const id of [...(this.byScope.get(sk(scope)) ?? [])]) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (!this.fresh(e, ttlMs, now)) {
        this.drop(id);
        continue;
      }
      if (e.context !== context || !e.vector) continue;
      const score = cosine(vector, e.vector);
      if (score >= threshold && (!best || score > best.score)) best = { id, e, score };
    }
    if (!best) return null;
    this.touch(best.id, best.e);
    return { value: best.e.value, score: best.score };
  }

  set(scope: CacheScope, exact: string, context: string, vector: Float32Array | null, value: V, ttlMs: number, now = Date.now()): void {
    const bytes = this.sizeOf(value) + (vector ? vector.length * 4 : 0) + exact.length + context.length;
    if (bytes > this.maxBytes / 16) return; // one huge answer never flushes everyone else's
    const s = sk(scope);
    const id = `${s}\u0000${exact}`;
    this.drop(id);
    this.entries.set(id, { scope: s, context, vector, value, at: now, expiresAt: now + ttlMs, bytes });
    const ids = this.byScope.get(s) ?? new Set<string>();
    ids.add(id);
    this.byScope.set(s, ids);
    this.used += bytes;
    if (ids.size > this.maxPerScope) this.drop(ids.values().next().value!);
    while (this.used > this.maxBytes && this.entries.size) this.drop(this.entries.keys().next().value!);
    if (now - this.lastSweep > SWEEP_MS) this.sweep(now);
  }

  /** Drop every expired entry (TTL as stored at write time). */
  sweep(now = Date.now()): void {
    this.lastSweep = now;
    for (const [id, e] of this.entries) if (e.expiresAt <= now) this.drop(id);
  }

  count(scope: CacheScope, what: 'lookup' | 'same' | 'similar' | 'embedError', savedMicros = 0): void {
    const k = orgRoute(scope);
    const c = this.counters.get(k) ?? { lookups: 0, sameHits: 0, similarHits: 0, embedErrors: 0, savedMicros: 0 };
    if (what === 'lookup') c.lookups += 1;
    else if (what === 'same') c.sameHits += 1;
    else if (what === 'similar') c.similarHits += 1;
    else c.embedErrors += 1;
    c.savedMicros += savedMicros;
    this.counters.set(k, c);
  }

  view(orgId: string): AiCacheStatsView {
    const prefix = `${orgId}\u0000`;
    const entries = new Map<string, number>();
    for (const [s, ids] of this.byScope) {
      if (!s.startsWith(prefix)) continue;
      const route = s.slice(prefix.length).split('\u0000')[0]!;
      entries.set(route, (entries.get(route) ?? 0) + ids.size);
    }
    const routes = new Set([...entries.keys()]);
    for (const k of this.counters.keys()) if (k.startsWith(prefix)) routes.add(k.slice(prefix.length));
    return {
      since: this.since.toISOString(),
      routes: [...routes].sort().map((route) => {
        const { savedMicros, ...c } = this.counters.get(`${prefix}${route}`) ?? { lookups: 0, sameHits: 0, similarHits: 0, embedErrors: 0, savedMicros: 0 };
        return { route, ...c, entries: entries.get(route) ?? 0, savedUsd: savedMicros / 1e6 };
      }),
    };
  }

  private fresh(e: Entry<V>, ttlMs: number, now: number): boolean {
    return now < e.expiresAt && now - e.at < ttlMs;
  }

  private touch(id: string, e: Entry<V>): void {
    this.entries.delete(id);
    this.entries.set(id, e);
    const ids = this.byScope.get(e.scope);
    ids?.delete(id);
    ids?.add(id);
  }

  private drop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.used -= e.bytes;
    const ids = this.byScope.get(e.scope);
    ids?.delete(id);
    if (ids && ids.size === 0) this.byScope.delete(e.scope);
  }
}
