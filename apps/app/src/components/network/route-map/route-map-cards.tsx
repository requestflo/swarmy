import * as React from 'react';
import { GlobeIcon, RadarIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import { msText, perMinText, type MapApp, type MapEdge, type RouteMap } from './route-map-model';

/** How a card reads against the lit path: on it, off it, or nothing picked. */
export type Lit = 'hot' | 'dim' | 'none';

function Card({ flow, lit, className, children }: { flow: string; lit: Lit; className?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-flow={flow}
      className={cn(
        'bg-card relative z-[1] flex min-w-0 flex-col gap-1 rounded-xl border px-3.5 py-2.5 motion-safe:transition-[opacity,border-color] motion-safe:duration-300',
        lit === 'hot' ? 'border-primary/70 ring-primary/25 ring-2' : 'border-border',
        lit === 'dim' && 'opacity-45',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function VisitorsCard({ v, lit }: { v: RouteMap['visitors']; lit: Lit }): React.JSX.Element {
  return (
    <Card flow="visitors" lit={lit}>
      <span className="flex items-center gap-2 text-[14px] font-semibold">
        <GlobeIcon aria-hidden className="text-primary size-4" />
        Visitors
      </span>
      {v.perMin === null ? (
        <span className="text-muted-foreground text-[12.5px]">No visits counted yet</span>
      ) : (
        <span className="font-mono text-[20px] font-semibold">
          {perMinText(v.perMin)}
          <span className="text-muted-foreground text-xs font-normal"> /min</span>
        </span>
      )}
      {v.regions.length > 0 ? (
        <ul aria-label="Visitors by region" className="text-muted-foreground flex flex-col font-mono text-[11px]">
          {v.regions.map((r) => (
            <li key={r.region ?? '~'} className="flex justify-between gap-3">
              <span className="truncate">{r.region ?? 'no region'}</span>
              <span>{perMinText(r.perMin)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function DnsCard({ geo, dnsServers, lit }: { geo: boolean; dnsServers: number; lit: Lit }): React.JSX.Element {
  return (
    <Card flow="dns" lit={lit}>
      <span className="flex items-center gap-2 text-[14px] font-semibold">
        <RadarIcon aria-hidden className="text-tone-info size-4" />
        {geo ? 'swarmy-dns' : 'Your DNS'}
      </span>
      <span className="text-muted-foreground text-[12.5px] leading-snug">
        {geo ? 'Answers with the edge closest to each visitor' : 'Points each address at your edges'}
      </span>
      <Tech>
        {geo ? `geo-DNS · :53${dnsServers > 0 ? ` on ${dnsServers} server${dnsServers === 1 ? '' : 's'}` : ''}` : 'A records at your registrar'}
      </Tech>
    </Card>
  );
}

/** The lit address's own visits a minute on this card (null = none lit, or no number for it). */
function ForAddress({ perMin }: { perMin: number | null | undefined }): React.JSX.Element | null {
  if (perMin === null || perMin === undefined) return null;
  return <span className="text-foreground font-mono text-[11.5px]">{perMinText(perMin)}/min for this address</span>;
}

/** An edge (board 13): its rate and its p50 — half its answers were quicker than this. */
export function EdgeCard({ e, lit, forAddress }: { e: MapEdge; lit: Lit; forAddress?: number | null }): React.JSX.Element {
  const line = e.perMin !== null ? `${perMinText(e.perMin)} a minute` : e.healthy ? 'No visits counted yet' : 'Not taking visits';
  const timing = e.p50Ms !== null ? ` · p50 ${msText(e.p50Ms)}${e.p95Ms !== null ? ` · p95 ${msText(e.p95Ms)}` : ''}` : '';
  return (
    <Card flow={`edge:${e.id}`} lit={lit}>
      <span className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[e.healthy ? 'ok' : 'idle'])} />
        <span className="truncate">{e.name}</span>
        {e.region ? <span className="border-border text-muted-foreground ml-auto shrink-0 rounded-md border px-1.5 font-mono text-[10.5px] font-medium">{e.region}</span> : null}
      </span>
      <span className="text-muted-foreground text-[12.5px]">
        {line}
        {e.p50Ms !== null ? (
          <>
            {' · answers in '}
            <span className="text-foreground font-mono" title="p50: half of this edge’s answers were quicker">{msText(e.p50Ms)}</span>
          </>
        ) : null}
      </span>
      <ForAddress perMin={forAddress} />
      <Tech>{`${e.ip ?? 'no public IP'} · Caddy :443${timing}`}</Tech>
    </Card>
  );
}

function whereText(where: string[] | undefined): string {
  if (!where) return 'Finding where it runs…';
  if (where.length === 0) return 'No copy running';
  return where.length > 3 ? `Runs on ${where.length} servers` : `Runs on ${where.join(', ')}`;
}

export function AppCard({ a, lit, forAddress }: { a: MapApp; lit: Lit; forAddress?: number | null }): React.JSX.Element {
  return (
    <Card flow={`app:${a.id}`} lit={lit}>
      <span className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[a.tone])} />
        <span className="truncate">
          {a.app} <span className="text-muted-foreground font-normal">/</span> {a.service}
        </span>
      </span>
      <span className="text-muted-foreground text-[12.5px]">{whereText(a.where)}</span>
      <ForAddress perMin={forAddress} />
      <span className="text-muted-foreground truncate font-mono text-[11px]">{a.hosts.join(' · ')}</span>
    </Card>
  );
}
