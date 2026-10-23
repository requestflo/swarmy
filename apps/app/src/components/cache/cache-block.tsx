import * as React from 'react';
import { TriangleAlertIcon, ZapIcon } from 'lucide-react';
import { CACHE_TOPOLOGIES } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Depth, StatusWord, TONE_TEXT, Tech, useDepth } from '@/components/calm';
import { FlowDiagram } from '@/components/stack-data/flow-diagram';
import { useMemberServers } from '@/components/stack-data/use-member-servers';
import { CacheBlockControls } from './cache-block-controls';
import { CacheSettings } from './cache-settings';
import { TOPO_WORDS, cacheDiagram, cacheTone, envVarOf, ifDies, sentinelLine, type CacheView } from './cache-words';

export const DIAGRAM_GRID = {
  backgroundImage: 'radial-gradient(circle, color-mix(in oklch, var(--foreground) 9%, transparent) 1px, transparent 1px)',
  backgroundSize: '18px 18px',
};

/**
 * One managed cache as the DataStores board lays it out (board 41): its
 * shape (fixed at create), apps → main copy → standby copies on their
 * servers, "If <server> dies: …", then memory, when full, persistence and
 * hit rate. Controls adds the knobs and the existing attach/saves/remove.
 */
export function CacheBlock({ v }: { v: CacheView }): React.JSX.Element {
  const tech = useDepth().atLeast('controls');
  const place = useMemberServers(`${v.stack}_${v.name}-cache`).byService;
  const model = cacheDiagram(v, place, tech);
  const dies = ifDies(v, place);
  const sentinels = sentinelLine(v, place);
  const tone = cacheTone(v);
  const hit = v.stats?.hitRatePct;

  return (
    <article aria-label={`The ${v.name} cache`} className="flex flex-col gap-3 py-4 first:pt-2">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span aria-hidden className="bg-status-warning/15 text-tone-warn flex size-7 items-center justify-center rounded-lg">
          <ZapIcon className="size-3.5" />
        </span>
        <h3 className="font-display text-[15.5px] font-bold">{v.name}</h3>
        <span className="text-muted-foreground font-mono text-[11.5px]">
          {v.engine} · {envVarOf(v)}
          {v.purpose === 'queue' ? ' · queue store' : ''}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {hit != null ? <span className="text-tone-ok font-mono text-[12px] font-semibold">hit {Math.round(hit)}%</span> : null}
          <StatusWord tone={tone} />
        </span>
      </header>
      <div role="group" className="flex flex-wrap gap-1.5" aria-label="Shape, fixed when it was made">
        {CACHE_TOPOLOGIES.map((t) => (
          <span
            key={t}
            aria-current={t === v.topology ? 'true' : undefined}
            className={cn('flex flex-col rounded-xl border px-3 py-1.5', t === v.topology ? 'border-foreground/30 bg-muted' : 'opacity-55')}
          >
            <b className="text-[12.5px] font-semibold">
              {TOPO_WORDS[t].label}
              {t === v.topology ? <span className="text-tone-ok"> · this one</span> : null}
            </b>
            <span className="text-muted-foreground text-[11px]">{TOPO_WORDS[t].hint}</span>
          </span>
        ))}
      </div>
      <Tech>swarmy.cache.topology={v.topology} · fixed when the cache was made (no in-place change)</Tech>
      <div className="flex flex-col gap-2 rounded-2xl border p-4" style={DIAGRAM_GRID}>
        <FlowDiagram columns={model.columns} links={model.links} label={`${v.name}: apps, main copy and standby copies`} />
        {sentinels ? <span className="text-tone-mesh font-mono text-[11px]">{sentinels}</span> : null}
      </div>
      <div className="bg-muted/60 flex items-start gap-2 rounded-xl px-3 py-2 text-[13px]">
        <TriangleAlertIcon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', TONE_TEXT[dies.tone])} />
        <span className="flex flex-col gap-0.5">
          <span>
            <b className="font-semibold">If {dies.server} dies:</b> <span className="text-muted-foreground">{dies.text}</span>
          </span>
          <Tech>{dies.tech}</Tech>
        </span>
      </div>
      <CacheSettings v={v} />
      <Depth at="controls">
        <CacheBlockControls v={v} />
      </Depth>
    </article>
  );
}
