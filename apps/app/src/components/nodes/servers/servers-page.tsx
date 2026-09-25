import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, Say, SayHeader } from '@/components/calm';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { PageError, PageSkeleton } from '@/components/states';
import { RecoveryClaimsBanner } from '../recovery-claims-banner';
import { SwarmHealthCard } from '../swarm-health-card';
import { useFleet } from './use-fleet';
import { ServersList } from './servers-list';
import { ServerInspector } from './server-inspector';
import { OfflineNext, TidyUpNext } from './servers-next-action';
import { ServersCode } from './servers-code';
import { ServersMap } from './servers-map';
import { gb } from './server-words';

/**
 * Servers (canvas "Servers" + RUpkeep): a sentence about the fleet, the one
 * thing worth doing (tidy a full disk, or look at a server that dropped off),
 * the list, and an inspector for the picked server. Controls adds the
 * machine facts, the swarm tooling and the map; Code adds the REST calls.
 */
export function ServersPage(): React.JSX.Element {
  const estate = useEstateSummary();
  const fleet = useFleet();
  const [picked, setPicked] = React.useState<string | null>(null);
  // Below xl the inspector sits under the list: bring it into view on pick.
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
  const selected =
    fleet.servers.find((s) => s.node.id === picked) ?? fleet.hot ?? down ?? fleet.servers[0] ?? null;
  const next = fleet.hot ? <TidyUpNext server={fleet.hot} /> : down ? <OfflineNext server={down} /> : null;

  const title = (
    <>
      {total === 0 ? 'No servers yet.' : online === total ? `All ${total} servers are online.` : `${online} of ${total} servers online.`}
      {fleet.hot ? (
        <>
          {' '}
          <Say tone="warn">{fleet.hot.node.name}’s disk is {fleet.hot.diskPct}% full.</Say>
        </>
      ) : down ? (
        <>
          {' '}
          <Say tone="bad">{down.node.name} is offline.</Say>
        </>
      ) : emptying ? (
        <em> {emptying.node.name} is being emptied.</em>
      ) : null}
    </>
  );
  const lede = fleet.pending
    ? undefined
    : [
        fleet.regions ? `${fleet.regions} region${fleet.regions === 1 ? '' : 's'}` : null,
        `${fleet.cpus} CPU`,
        `${gb(fleet.memBytes)} memory`,
        fleet.monthlyUsd ? `$${fleet.monthlyUsd.toFixed(0)}/mo` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <CalmPage
      crumbs={[{ label: 'Servers' }]}
      aside={
        fleet.servers.length > 0 ? (
          <>
            <ServersCode servers={fleet.servers} selected={selected} />
            {selected ? <ServerInspector server={selected} /> : null}
          </>
        ) : undefined
      }
    >
      <SayHeader
        title={title}
        lede={lede}
        actions={
          <Button asChild variant={next ? 'outline' : 'default'} className="pointer-coarse:min-h-11">
            <Link to="/nodes/new">
              <PlusIcon className="size-4" /> Add a server
            </Link>
          </Button>
        }
      />
      {next}
      <RecoveryClaimsBanner />
      <ServersList servers={fleet.servers} pending={fleet.pending} selectedId={selected?.node.id ?? null} onSelect={pick} />
      <Depth at="controls">
        <SwarmHealthCard />
        <ServersMap />
      </Depth>
    </CalmPage>
  );
}
