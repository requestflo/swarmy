import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, SayHeader, useDepth } from '@/components/calm';
import { AppsViewToggle } from '@/components/apps/apps-view-toggle';
import { useIsPlatformAdmin } from '@/components/platform/use-platform';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { PageError, PageSkeleton } from '@/components/states';
import { RecoveryClaimsBanner } from '../recovery-claims-banner';
import { SwarmHealthCard } from '../swarm-health-card';
import { FleetSection } from './fleet/fleet-section';
import { useFleetMap } from './fleet/use-fleet-map';
import { MoveProvider, useMove } from './move/move-context';
import { MovePanel } from './move/move-panel';
import { useFleet } from './use-fleet';
import { useServersView } from './use-servers-view';
import { ServersList } from './servers-list';
import { ServerInspector } from './server-inspector';
import { OfflineNext, TidyUpNext } from './servers-next-action';
import { ServersCode } from './servers-code';
import { serversLede, serversTitle } from './servers-say';

/**
 * Servers (boards 11 and 9 + RUpkeep): a sentence about the fleet, the one
 * thing worth doing, then the fleet as a map — region zones, ring tiles,
 * private-network links — or as a list (a view toggle). Picking a server
 * fills the inspector; "x" selects several for bulk actions; admins drag a
 * service onto another server (or use "Move…") to move it with a fit check.
 */
export function ServersPage(): React.JSX.Element {
  const admin = useIsPlatformAdmin();
  return (
    <MoveProvider admin={admin}>
      <ServersScreen />
    </MoveProvider>
  );
}

function ServersScreen(): React.JSX.Element {
  const estate = useEstateSummary();
  const fleet = useFleet();
  const map = useFleetMap(fleet);
  const move = useMove();
  const code = useDepth().atLeast('code');
  const [view, setView] = useServersView();
  const [picked, setPicked] = React.useState<string | null>(null);
  // Below xl the inspector sits under the main column: bring it into view on pick.
  const pick = React.useCallback((id: string) => {
    setPicked(id);
    if (window.matchMedia('(max-width: 1279px)').matches) {
      requestAnimationFrame(() => document.getElementById('server-inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, []);

  if (estate.status === 'pending') return <PageSkeleton variant="kpis" />;
  if (estate.status === 'error') {
    return <PageError title="Couldn’t reach your servers." error={estate.error} retry={estate.refetch} retrying={estate.isFetching} />;
  }

  const { online, total } = estate.data.nodes;
  const down = fleet.servers.find((s) => s.node.status === 'offline') ?? null;
  const emptying = fleet.servers.find((s) => s.node.status === 'draining') ?? null;
  const selected = fleet.servers.find((s) => s.node.id === picked) ?? fleet.hot ?? down ?? fleet.servers[0] ?? null;
  // The move confirm is this moment's one coral action; everything else steps back.
  const confirming = move.stage === 'confirm';
  const next = fleet.hot ? <TidyUpNext server={fleet.hot} quiet={confirming} /> : down ? <OfflineNext server={down} quiet={confirming} /> : null;
  const servers = (map.groups ?? []).flatMap((g) => g.servers);

  return (
    <CalmPage
      crumbs={[{ label: 'Servers' }]}
      actions={fleet.servers.length > 0 ? <AppsViewToggle view={view} onChange={setView} /> : undefined}
      wide
      aside={
        fleet.servers.length > 0 ? (
          <>
            {code ? <ServersCode servers={fleet.servers} selected={selected} /> : null}
            <MovePanel servers={servers} inventory={map.inventory} />
            {selected ? <ServerInspector server={selected} view={map.byId.get(selected.node.id)} /> : null}
          </>
        ) : undefined
      }
    >
      <SayHeader
        title={serversTitle({ online, total, fleet, down, emptying })}
        lede={serversLede(fleet)}
        actions={
          <Button asChild variant={next || confirming ? 'outline' : 'default'} className="pointer-coarse:min-h-11">
            <Link to="/nodes/new">
              <PlusIcon className="size-4" /> Add a server
            </Link>
          </Button>
        }
      />
      {next}
      <RecoveryClaimsBanner />
      {view === 'map' && fleet.servers.length > 0 ? (
        <FleetSection map={map} selectedId={selected?.node.id ?? null} onInspect={pick} />
      ) : (
        <ServersList servers={fleet.servers} pending={fleet.pending} selectedId={selected?.node.id ?? null} onSelect={pick} />
      )}
      <Depth at="controls">
        <SwarmHealthCard />
      </Depth>
    </CalmPage>
  );
}
