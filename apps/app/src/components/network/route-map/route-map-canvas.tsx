import * as React from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { FlowSvg } from '@/components/flow/flow-svg';
import { useFlowPaths, type FlowLink, type FlowTone } from '@/components/flow/use-flow-paths';
import { AppCard, DnsCard, EdgeCard, VisitorsCard, type Lit } from './route-map-cards';
import type { LitPath, MapEdge, RouteMap } from './route-map-model';

/** The links: visitors → DNS → every edge → every app (each edge carries every address). */
function linksFor(map: RouteMap, lit: LitPath | null): FlowLink[] {
  const tone = (on: boolean): FlowTone => (!lit ? 'base' : on ? 'hot' : 'dim');
  const out: FlowLink[] = [{ from: 'visitors', to: 'dns', tone: tone(true) }];
  for (const e of map.edges) {
    out.push({ from: 'dns', to: `edge:${e.id}`, tone: tone(!!lit?.edges.has(e.id)), dashed: !e.healthy });
    for (const a of map.apps) {
      out.push({ from: `edge:${e.id}`, to: `app:${a.id}`, tone: tone(!!lit?.edges.has(e.id) && lit.app === a.id), dashed: !e.healthy });
    }
  }
  return out;
}

/** The lit address's visits a minute on this edge: a real 0 only when the edge itself reported. */
function addressOn(e: MapEdge, lit: LitPath | null): number | null {
  if (!lit?.edges.has(e.id) || lit.perMin === null || e.perMin === null) return null;
  return lit.byEdge.get(e.id) ?? 0;
}

function Column({ head, children }: { head: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">{head}</span>
      <div className="flex flex-1 flex-col justify-center gap-2.5">{children}</div>
    </div>
  );
}

function Down(): React.JSX.Element {
  return <ArrowDownIcon aria-hidden className="text-muted-foreground mx-auto size-4 md:hidden" />;
}

/**
 * Board 13's four stages. Wide: four columns with the links drawn between the
 * real cards. Narrow: the same cards stacked, the lit ones ringed.
 */
export function RouteMapCanvas({ map, lit, geo, dnsServers }: { map: RouteMap; lit: LitPath | null; geo: boolean; dnsServers: number }): React.JSX.Element {
  const links = React.useMemo(() => linksFor(map, lit), [map, lit]);
  const flow = useFlowPaths(links);
  const on = (hot: boolean): Lit => (!lit ? 'none' : hot ? 'hot' : 'dim');
  return (
    <figure
      ref={flow.ref}
      aria-label="How a visitor reaches each app"
      className="relative flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,0.85fr)_minmax(0,0.95fr)_minmax(0,1.1fr)_minmax(0,1.25fr)] md:gap-x-14"
    >
      <div className="pointer-events-none absolute inset-0 hidden md:block">
        <FlowSvg paths={flow.paths} size={flow.size} />
      </div>
      <Column head="Visitors">
        <VisitorsCard v={map.visitors} lit={on(true)} />
      </Column>
      <Down />
      <Column head={geo ? 'Geo-DNS' : 'DNS'}>
        <DnsCard geo={geo} dnsServers={dnsServers} lit={on(true)} />
      </Column>
      <Down />
      <Column head="Nearest edge">
        {map.edges.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">No edge is running yet.</p>
        ) : (
          map.edges.map((e) => <EdgeCard key={e.id} e={e} lit={on(!!lit?.edges.has(e.id))} forAddress={addressOn(e, lit)} />)
        )}
      </Column>
      <Down />
      <Column head="App">
        {map.apps.map((a) => (
          <AppCard key={a.id} a={a} lit={on(lit?.app === a.id)} forAddress={lit?.app === a.id ? lit.perMin : null} />
        ))}
      </Column>
    </figure>
  );
}
