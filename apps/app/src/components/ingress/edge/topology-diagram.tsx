import * as React from 'react';
import { ArrowDownIcon, GlobeIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech, type Tone } from '@/components/calm';
import { FlowSvg } from '@/components/flow/flow-svg';
import { useFlowPaths, type FlowLink } from '@/components/flow/use-flow-paths';
import type { TopoCard, TopoView } from './topology-model';

function Card({ flow, card, tone, icon, preview }: { flow: string; card: TopoCard; tone?: Tone; icon?: React.ReactNode; preview: boolean }): React.JSX.Element {
  return (
    <div
      data-flow={flow}
      className={cn(
        'bg-card relative z-[1] flex min-w-0 flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300',
        preview ? 'border-primary/50 border-dashed' : 'border-border',
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
        {icon ?? (tone ? <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} /> : null)}
        <span className="truncate">{card.title}</span>
      </span>
      <span className="text-muted-foreground text-[12.5px] leading-snug">{card.sub}</span>
      <Tech>{card.tech}</Tech>
    </div>
  );
}

function Column({ head, children }: { head: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">{head}</span>
      <div className="flex flex-1 flex-col justify-center gap-2.5">{children}</div>
    </div>
  );
}

const Down = (): React.JSX.Element => <ArrowDownIcon aria-hidden className="text-muted-foreground mx-auto size-4 md:hidden" />;

/**
 * Board 31's topology picture: visitors → DNS (or swarmy-dns) → the edge(s)
 * → your apps, with the certificate store beside the edges. It redraws for
 * the topology being previewed, so picking the other one shows what changes.
 */
export function TopologyDiagram({ view, preview }: { view: TopoView; preview: boolean }): React.JSX.Element {
  const links = React.useMemo<FlowLink[]>(
    () => [
      { from: 'visitors', to: 'mid', tone: 'base' },
      ...view.edges.flatMap((e): FlowLink[] => [
        { from: 'mid', to: `edge:${e.id}`, tone: e.healthy ? 'base' : 'dim', dashed: !e.healthy },
        { from: `edge:${e.id}`, to: 'apps', tone: e.healthy ? 'base' : 'dim', dashed: !e.healthy },
        { from: 'certs', to: `edge:${e.id}`, tone: 'mesh', dashed: true, route: 'left' },
      ]),
    ],
    [view],
  );
  const flow = useFlowPaths(links);
  return (
    <figure
      ref={flow.ref}
      aria-label="How visitors reach your edges"
      className="relative flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)] md:gap-x-14"
    >
      <div className="pointer-events-none absolute inset-0 hidden md:block">
        <FlowSvg paths={flow.paths} size={flow.size} />
      </div>
      <Column head="Visitors">
        <Card flow="visitors" preview={false} icon={<GlobeIcon aria-hidden className="text-primary size-4" />} card={{ title: 'Visitors', sub: 'Anyone opening your addresses', tech: 'https :443 · http :80 redirects' }} />
      </Column>
      <Down />
      <Column head="Finds the edge">
        <Card flow="mid" preview={preview} tone="info" card={view.mid} />
      </Column>
      <Down />
      <Column head={view.edges.length === 1 ? 'The edge' : 'Edges'}>
        {view.edges.length === 0 ? <p className="text-muted-foreground text-[13px]">No server is marked as an edge yet.</p> : null}
        {view.edges.map((e) => (
          <Card key={e.id} flow={`edge:${e.id}`} preview={preview} tone={e.healthy ? 'ok' : 'idle'} card={e} />
        ))}
        <div className="md:pl-6">
          <Card flow="certs" preview={preview} tone="mesh" card={view.certs} />
        </div>
      </Column>
      <Down />
      <Column head="Apps">
        <Card flow="apps" preview={false} tone="ok" card={view.apps} />
      </Column>
    </figure>
  );
}
