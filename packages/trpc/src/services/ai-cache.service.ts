/**
 * The AI gateway's answer cache — control plane. A route opts in on the AI
 * config document (`routeCache.<route>`, next to the routes themselves); the
 * stored answers and their counters live in the gateway's process memory
 * (apps/api `ai/route-cache.ts`), read here through the in-process seam.
 */
import { aiCacheStats, parseConfigDoc, type AiCacheStatsView, type AiModelsView, type SetAiRouteCacheInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { listModels, loadConfig, saveConfig } from './ai.service';

export async function setRouteCache(ctx: OrgContext, input: SetAiRouteCacheInput): Promise<AiModelsView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const previous = doc.routeCache[input.route] ?? null;
  if (input.cache) doc.routeCache[input.route] = { ttlSeconds: input.cache.ttlSeconds, similarity: input.cache.similarity };
  else delete doc.routeCache[input.route];
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, {
    action: 'ai.routeCache.set',
    targetType: 'aiRoute',
    targetId: input.route,
    metadata: { cache: input.cache, previous },
  });
  return listModels(ctx);
}

/** Per-route counters since the gateway started (empty when no gateway runs in-process). */
export function cacheStats(ctx: OrgContext): AiCacheStatsView {
  const read = aiCacheStats();
  if (!read) return { since: null, routes: [] };
  try {
    return read(ctx.activeOrgId);
  } catch {
    return { since: null, routes: [] };
  }
}
