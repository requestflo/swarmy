import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import type { MapRegion } from './map-model';

/**
 * The map (board AppPlacement): each region a zone, each server a card with
 * a marker for every part of this app that has a copy there — the picked
 * part in coral. Regions the picked part is declared in are outlined.
 */
export function RegionMap({ map, part, declared }: { map: MapRegion[] | undefined; part: string; declared: Map<string, number> }): React.JSX.Element {
  if (!map) return <CardSkeleton lines={3} />;
  if (map.length === 0) return <p className="text-muted-foreground text-[13px]">No servers are online to place anything on.</p>;
  return (
    <div className="flex flex-wrap gap-3" aria-label={`Where this app's copies run, by region`}>
      {map.map((r) => {
        const on = r.region !== null && declared.has(r.region);
        return (
          <section
            key={r.region ?? '-'}
            aria-label={r.region ?? 'No region'}
            className={cn('bg-background flex min-w-0 flex-[1_1_16rem] flex-col gap-2 rounded-xl border p-3', on ? 'border-primary/60' : 'border-border border-dashed')}
          >
            <span className="calm-eyebrow">
              {r.region ?? 'no region'} · {r.servers.length} server{r.servers.length === 1 ? '' : 's'}
            </span>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
              {r.servers.map((s) => (
                <li key={s.node.id} className="bg-card border-border flex min-w-0 flex-col gap-1.5 rounded-lg border px-2.5 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
                    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', s.node.status === 'online' ? TONE_DOT.ok : TONE_DOT.idle)} />
                    <span className="truncate">{s.node.name}</span>
                  </span>
                  {s.nat ? <span className="text-tone-mesh -mt-1 font-mono text-[10px]">private network only</span> : null}
                  <span className="flex min-h-5 flex-wrap gap-1">
                    {s.parts.length === 0 ? (
                      <span className="text-muted-foreground font-mono text-[10.5px]">nothing of this app</span>
                    ) : (
                      s.parts.map((p) => (
                        <span
                          key={p}
                          className={cn('rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold', p === part ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground/80')}
                        >
                          {p}
                        </span>
                      ))
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
