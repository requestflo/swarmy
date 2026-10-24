import * as React from 'react';
import { ROUTE_CACHE_SIMILARITY, type AiRouteCache } from '@swarmy/core';
import { Tech } from '@/components/calm';
import { Segmented } from '@/components/rum/rum-ui';
import type { AnswerCacheRoute } from './use-answer-cache';

type Mode = 'off' | 'same' | 'similar';

const KEEP: Array<{ value: number; label: string }> = [
  { value: 900, label: '15 min' },
  { value: 3_600, label: '1 h' },
  { value: 86_400, label: '1 day' },
  { value: 604_800, label: '7 days' },
];

const modeOf = (s: AiRouteCache | null): Mode => (!s ? 'off' : s.similarity === null ? 'same' : 'similar');

/** What the cache did for this route, in one sentence. */
function sentence(r: AnswerCacheRoute): string {
  if (!r.setting) return 'Off — every question goes to the model.';
  const s = r.stats;
  if (!s || s.lookups === 0) return 'On — nothing asked yet since the gateway started.';
  const saved = s.savedUsd >= 0.01 ? ` · about $${s.savedUsd.toFixed(2)} saved` : '';
  return `${r.hitRatePct ?? 0}% answered from memory (${s.sameHits + s.similarHits} of ${s.lookups})${saved}.`;
}

/** One chat route: its cache mode, how long answers are kept, and the hit rate. */
export function AnswerCacheRow({
  route,
  embedReady,
  saving,
  onSave,
}: {
  route: AnswerCacheRoute;
  embedReady: boolean;
  saving: boolean;
  onSave: (cache: AiRouteCache | null) => void;
}): React.JSX.Element {
  const mode = modeOf(route.setting);
  const ttl = route.setting?.ttlSeconds ?? 3_600;
  const similarity = route.setting?.similarity ?? ROUTE_CACHE_SIMILARITY.default;
  const pick = (m: Mode): void => onSave(m === 'off' ? null : { ttlSeconds: ttl, similarity: m === 'similar' ? similarity : null });
  const s = route.stats;
  return (
    <div className="border-border flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[13.5px] font-semibold">{route.name}</span>
        <span className="text-muted-foreground min-w-0 flex-1 text-[13px]">{sentence(route)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Mode>
          label={`Answer cache for ${route.name}`}
          value={mode}
          disabled={saving}
          onChange={pick}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'same', label: 'Same question' },
            ...(embedReady || mode === 'similar' ? [{ value: 'similar' as const, label: 'Similar too' }] : []),
          ]}
        />
        {route.setting ? (
          <Segmented<number>
            label={`Keep answers for ${route.name}`}
            value={ttl}
            disabled={saving}
            onChange={(v) => onSave({ ttlSeconds: v, similarity: route.setting!.similarity })}
            options={KEEP.some((k) => k.value === ttl) ? KEEP : [...KEEP, { value: ttl, label: `${Math.round(ttl / 60)} min` }]}
          />
        ) : null}
      </div>
      {route.setting ? (
        <Tech>
          {`routeCache.${route.name} = { ttlSeconds: ${ttl}, similarity: ${route.setting.similarity ?? 'null'} }`}
          {s ? ` · ${s.sameHits} same · ${s.similarHits} similar · ${s.entries} stored${s.embedErrors ? ` · ${s.embedErrors} embed errors` : ''}` : ''}
        </Tech>
      ) : null}
    </div>
  );
}
