/**
 * Answer-cache counters, as the dashboard reads them. The counters are run
 * state: they live in the gateway's process memory next to the cached
 * answers and reset with them on a controller restart — never in the store,
 * a label or a swarm config. The long-run hit rate comes from `AiUsage.cacheHit`.
 */

/** One route's cache since the gateway started. */
export interface AiRouteCacheStatsView {
  route: string;
  /** Non-streaming requests the cache was asked about. */
  lookups: number;
  /** Answered from a stored answer to the same question. */
  sameHits: number;
  /** Answered from a stored answer to a similar question (`embed`). */
  similarHits: number;
  /** Answers stored right now, across the org's keys. */
  entries: number;
  /** Estimated cost the hits didn't spend (static price table). */
  savedUsd: number;
  /** Similar-question lookups skipped because the `embed` call failed. */
  embedErrors: number;
}

export interface AiCacheStatsView {
  /** When the counters started (the gateway's start); null when no gateway runs in this process. */
  since: string | null;
  routes: AiRouteCacheStatsView[];
}

/** Share of lookups answered from cache, 0–100 (null before the first lookup). */
export function cacheHitRatePct(s: Pick<AiRouteCacheStatsView, 'lookups' | 'sameHits' | 'similarHits'>): number | null {
  if (s.lookups <= 0) return null;
  return Math.round(((s.sameHits + s.similarHits) / s.lookups) * 1000) / 10;
}

export type AiCacheStatsSource = (orgId: string) => AiCacheStatsView;

let source: AiCacheStatsSource | null = null;

/** The data plane (apps/api) registers its cache here so @swarmy/trpc can read it in-process. */
export function registerAiCacheStats(fn: AiCacheStatsSource | null): void {
  source = fn;
}

export function aiCacheStats(): AiCacheStatsSource | null {
  return source;
}
