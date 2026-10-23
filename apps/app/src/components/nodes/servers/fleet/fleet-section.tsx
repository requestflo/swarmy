import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { SquareCheckIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { plural } from '@/components/apps/app-words';
import { CardSkeleton } from '@/components/states';
import { useMinWidth } from '@/lib/use-min-width';
import { useMove } from '../move/move-context';
import { useMovePlan } from '../move/use-move-plan';
import { FleetMap } from './fleet-map';
import { FleetPhone } from './fleet-phone';
import { MultiBar } from './multi-bar';
import { useMultiSelect } from './use-multi-select';
import type { FleetMap as FleetMapData } from './use-fleet-map';

const Kbd = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <kbd className="bg-surface-2 border-border rounded-md border px-1.5 font-mono text-[11px] dark:bg-accent">{children}</kbd>
);

/**
 * Board 11's map card: the toolbar (what's on the map, Select, the private
 * network), the map itself (a stacked list on phones), and the footer — the
 * how-to line, or the selection bar while selecting.
 */
export function FleetSection({ map, selectedId, onInspect }: { map: FleetMapData; selectedId: string | null; onInspect: (id: string) => void }): React.JSX.Element {
  const lg = useMinWidth(1024);
  const m = useMove();
  const multi = useMultiSelect(selectedId);
  const servers = React.useMemo(() => (map.groups ?? []).flatMap((g) => g.servers), [map.groups]);
  const plan = useMovePlan(m.stage === 'drag' || m.stage === 'confirm' ? m.draft : null, servers, m.admin);
  const regions = (map.groups ?? []).filter((g) => g.region).length;
  const tile = {
    selectedId,
    picking: multi.picking,
    picked: multi.picked,
    onPick: multi.picking ? multi.flip : onInspect,
    plan,
  };

  return (
    <section aria-label="Map of your servers" className="calm-card relative overflow-hidden">
      <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <p className="text-muted-foreground font-mono text-[12px]">
          {map.groups ? `${plural(servers.length, 'server')} · ${plural(regions, 'region')}` : 'Finding your servers…'}
        </p>
        <div className="flex-1" />
        {map.meshOn ? (
          <Link to="/networking" className="text-muted-foreground hover:text-foreground font-mono text-[12px] pointer-coarse:min-h-11">
            Private network →
          </Link>
        ) : null}
        <Button size="sm" variant="outline" aria-pressed={multi.picking} onClick={() => multi.toggle(selectedId)} className="pointer-coarse:min-h-11">
          <SquareCheckIcon aria-hidden className="size-3.5" />
          {multi.picking ? 'Selecting' : 'Select'}
          <Kbd>x</Kbd>
        </Button>
      </div>
      <div className={lg ? undefined : 'p-3'}>
        {!map.groups ? (
          <div className="p-4">
            <CardSkeleton />
          </div>
        ) : lg ? (
          <FleetMap groups={map.groups} links={map.links} meshOn={map.meshOn} {...tile} />
        ) : (
          <FleetPhone groups={map.groups} meshOn={map.meshOn} {...tile} />
        )}
      </div>
      <div className="border-border border-t px-4 py-2.5">
        {multi.picking ? (
          <MultiBar picked={servers.filter((s) => multi.picked.has(s.server.node.id)).map((s) => s.server.node)} admin={m.admin} onDone={multi.done} />
        ) : (
          <p className="text-muted-foreground font-mono text-[12px]">
            Click a server to inspect · <Kbd>x</Kbd> to select several
            {m.admin ? (lg ? ' · drag a service onto a server to move it' : ' · Move… in the inspector moves a service') : ''}
          </p>
        )}
      </div>
    </section>
  );
}
