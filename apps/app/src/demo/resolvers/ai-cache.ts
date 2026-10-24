import type { AiCacheStatsView, AiModelsView, AiRouteCache, AiRouteCacheStatsView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { ai } from './ai';

/**
 * The AI gateway's answer cache in demo mode (mirrors `ai-cache.service.ts`):
 * `smart` matches similar questions, `fast` the same question only, and the
 * counters read as a few hours of real traffic. State: `store.extra.aiCache`.
 */
interface AiCacheState {
  routeCache: Record<string, AiRouteCache>;
  since: string;
}

type Counters = Omit<AiRouteCacheStatsView, 'route'>;

const SEEDED: Record<string, Counters> = {
  smart: { lookups: 1_840, sameHits: 412, similarHits: 236, entries: 318, savedUsd: 6.42, embedErrors: 0 },
  fast: { lookups: 960, sameHits: 301, similarHits: 0, entries: 122, savedUsd: 0.38, embedErrors: 0 },
};
const EMPTY: Counters = { lookups: 0, sameHits: 0, similarHits: 0, entries: 0, savedUsd: 0, embedErrors: 0 };

/** The demo org's route cache settings (read by `ai.models` too). */
export function demoRouteCache(store: DemoStore): Record<string, AiRouteCache> {
  return (store.extra.aiCache as AiCacheState | undefined)?.routeCache ?? {};
}

export const aiCache: DomainResolvers = {
  seed: (store) => {
    store.extra.aiCache = {
      routeCache: { smart: { ttlSeconds: 3_600, similarity: 0.95 }, fast: { ttlSeconds: 900, similarity: null } },
      since: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    } satisfies AiCacheState;
  },
  handlers: {
    'ai.cacheStats': (_i, s): AiCacheStatsView => {
      const st = s.extra.aiCache as AiCacheState;
      const names = [...new Set([...Object.keys(SEEDED), ...Object.keys(st.routeCache)])].sort();
      return { since: st.since, routes: names.map((route) => ({ route, ...(SEEDED[route] ?? EMPTY) })) };
    },
    'ai.setRouteCache': (i, s): AiModelsView => {
      const b = i as { route: string; cache: AiRouteCache | null };
      const st = s.extra.aiCache as AiCacheState;
      if (b.cache) st.routeCache[b.route] = { ttlSeconds: b.cache.ttlSeconds, similarity: b.cache.similarity };
      else delete st.routeCache[b.route];
      return ai.handlers!['ai.models']!(undefined, s) as AiModelsView;
    },
  },
};
