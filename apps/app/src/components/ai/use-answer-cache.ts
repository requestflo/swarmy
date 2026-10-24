import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { cacheHitRatePct, type AiRouteCache, type AiRouteCacheStatsView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface AnswerCacheRoute {
  name: string;
  setting: AiRouteCache | null;
  stats: AiRouteCacheStatsView | null;
  hitRatePct: number | null;
}

/** The chat routes, their answer-cache setting and live counters, and the setter. */
export function useAnswerCache() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const models = useQuery({ ...trpc.ai.models.queryOptions(), refetchInterval: 30_000 });
  const stats = useQuery({ ...trpc.ai.cacheStats.queryOptions(), refetchInterval: 10_000 });
  const set = useMutation(
    trpc.ai.setRouteCache.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const m = models.data;
  const byRoute = new Map((stats.data?.routes ?? []).map((r) => [r.route, r]));
  const routes: AnswerCacheRoute[] = (m?.models ?? [])
    .filter((x) => x.source === 'alias' && x.kind === 'chat')
    .map((x) => {
      const s = byRoute.get(x.name) ?? null;
      return { name: x.name, setting: m?.routeCache[x.name] ?? null, stats: s, hitRatePct: s ? cacheHitRatePct(s) : null };
    });
  return {
    pending: models.isPending,
    error: models.isError ? models.error : null,
    routes,
    /** `embed` resolves, so "similar question" matching can run. */
    embedReady: (m?.models ?? []).some((x) => x.name === 'embed' && x.source === 'alias'),
    since: stats.data?.since ?? null,
    save: (route: string, cache: AiRouteCache | null) => set.mutate({ route, cache }),
    saving: set.isPending,
  };
}

/** The aside line: which routes cache, and their hit rate since the gateway started. */
export function answerCacheLine(routes: readonly AnswerCacheRoute[], orgCacheOn: boolean | undefined): string {
  const on = routes.filter((r) => r.setting);
  const lookups = on.reduce((n, r) => n + (r.stats?.lookups ?? 0), 0);
  const hits = on.reduce((n, r) => n + (r.stats?.sameHits ?? 0) + (r.stats?.similarHits ?? 0), 0);
  if (on.length) {
    const names = on.map((r) => r.name).join(', ');
    return lookups ? `${names} answer repeat questions · ${Math.round((hits / lookups) * 100)}% from memory` : `${names} answer repeat questions`;
  }
  return orgCacheOn ? 'identical requests cost nothing for 5 minutes' : 'off';
}
