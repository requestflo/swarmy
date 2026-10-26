import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { regionCoord } from '@swarmy/dns/steer';
import { cn } from '@swarmy/ui';
import { Section, StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { MapEdge } from '@/components/domains/resolver-map';
import { ASK_FROM, arcPath, askAnswer, mapPct, mapXY, type AskEndpoint, type AskFrom } from './ask-model';
import type { DnsZoneView } from './geo-types';
import { SimulateDown } from './simulate-down';

const ResolverMap = React.lazy(() => import('@/components/domains/resolver-map'));

/**
 * "Ask from anywhere" (board 32): pick where a visitor is and see the exact
 * answer swarmy-dns gives them (`geodns.previewResolution` runs the real
 * answering engine on the composed zone), with an arc to the front door it
 * picked, the distance and why.
 */
export function AskAnywhere({ zone, host, endpoints }: { zone: DnsZoneView; host: string | null; endpoints: AskEndpoint[] }): React.JSX.Element {
  const trpc = useTRPC();
  const [from, setFrom] = React.useState<AskFrom>('eu');
  const preview = useQuery({
    ...trpc.geodns.previewResolution.queryOptions({ id: zone.id, host: host ?? zone.zone, region: from }),
    enabled: !!host,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const place = ASK_FROM.find((r) => r.id === from)!;
  const ans = preview.data && !preview.isPlaceholderData ? askAnswer(from, preview.data, endpoints) : null;
  const visitor = regionCoord(from);
  const target = ans?.edge ? regionCoord(ans.edge.region) : undefined;
  const edges: MapEdge[] = endpoints.flatMap((e) => {
    const c = regionCoord(e.region);
    return c ? [{ name: e.healthy ? e.name : `${e.name} · out`, lat: c.lat, lon: c.lon }] : [];
  });
  const v = visitor ? mapXY(visitor) : null;
  const overlay = v ? (
    <g>
      {visitor && target ? <path d={arcPath(visitor, target)} fill="none" stroke="var(--color-primary)" strokeWidth={2.5} strokeDasharray="7 6" strokeLinecap="round" /> : null}
      <circle cx={v.x} cy={v.y} r={7} fill="var(--color-primary)" stroke="var(--color-card)" strokeWidth={2.5} />
    </g>
  ) : null;

  return (
    <Section title="Ask from anywhere" hint="Click a region to see swarmy-dns’s answer">
      <div className="border-border relative overflow-hidden rounded-md border">
        <React.Suspense fallback={<div className="bg-muted aspect-[960/372] w-full animate-pulse" />}>
          <ResolverMap edges={edges} overlay={overlay} label={`World map: your front doors${ans?.edge ? `; a visitor in ${place.label} gets ${ans.edge.name}` : ''}`} />
        </React.Suspense>
        {ASK_FROM.map((r) => {
          const p = mapPct(r.pin);
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={from === r.id}
              onClick={() => setFrom(r.id)}
              style={{ left: `${p.left}%`, top: `${p.top}%` }}
              className={cn(
                'absolute hidden h-7 -translate-x-1/2 -translate-y-1/2 items-center rounded-full border px-2.5 text-[11.5px] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:inline-flex',
                from === r.id ? 'bg-primary text-primary-foreground border-transparent' : 'bg-card border-border hover:border-primary/60',
              )}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <div role="group" aria-label="Ask from" className="flex flex-wrap gap-1.5 sm:hidden">
        {ASK_FROM.map((r) => (
          <button key={r.id} type="button" aria-pressed={from === r.id} onClick={() => setFrom(r.id)} className={cn('min-h-11 rounded-full border px-3 text-[12.5px] font-semibold', from === r.id ? 'bg-primary text-primary-foreground border-transparent' : 'bg-card border-border')}>
            {r.label}
          </button>
        ))}
      </div>
      {!host ? (
        <p className="text-muted-foreground text-[13.5px]">Nothing to answer for in {zone.zone} yet. Give an app an address under it and swarmy answers for it here.</p>
      ) : preview.isError ? (
        <p className="text-tone-bad text-[13.5px]">{preview.error.message}</p>
      ) : !ans ? (
        <div className="shimmer-line h-11 rounded-md" aria-hidden />
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[14px] font-semibold break-all">
              {place.label} → {ans.edge ? `${ans.edge.name} ${ans.edge.ip}` : 'nothing'}
              {ans.km !== null ? ` · ${ans.km.toLocaleString('en-GB')} km` : ''}
              {ans.ttl !== null ? ` · TTL ${ans.ttl}` : ''}
            </span>
            <StatusWord tone={ans.tone} word={ans.word} className="ml-auto" />
          </div>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{ans.why}</p>
          <Tech>
            {host} A from region “{from}” → {preview.data?.answers.map((a) => a.value).join(', ') || 'no records'} · {preview.data?.rcode} · steered {String(preview.data?.steered)} · degraded {String(preview.data?.degraded)}
          </Tech>
        </div>
      )}
      <SimulateDown zone={zone} host={host} endpoints={endpoints} from={from} />
    </Section>
  );
}
