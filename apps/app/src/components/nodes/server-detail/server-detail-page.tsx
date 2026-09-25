import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, Say, SayHeader } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { NodeLivePanel } from '../node-live-panel';
import { NodeContainersPanel } from '../node-containers-panel';
import { NodeControlsPanel } from '../node-controls-panel';
import { NodeRepairCard } from '../node-repair-card';
import { NodeSwarmJoinBanner } from '../node-swarm-join-banner';
import { NodeHygienePanel } from '../node-hygiene-panel';
import { NodeOldCopiesCard } from '../node-old-copies-card';
import { NodeRetirePanel } from '../node-retire-panel';
import { NodeDisksCard } from '../node-disks-card';
import { ServerInspector } from '../servers/server-inspector';
import { TidyUpNext } from '../servers/servers-next-action';
import { DISK_HOT_PCT } from '../servers/use-fleet';
import { gb, plainRoles } from '../servers/server-words';
import { ServerCode } from './server-code';
import { useServer } from './use-server';

const STATE_SAY: Record<string, string> = {
  online: 'is online.',
  draining: 'is being emptied.',
  offline: 'is offline.',
  degraded: 'is struggling.',
  pending: 'is joining.',
};

/**
 * One server (the Servers inspector, full page): a sentence, the one thing
 * worth doing (a full disk → Tidy up), what runs here, retirement. Controls
 * adds the live chart, every knob, cleanup history, disks and old copies;
 * Code adds GET /nodes/{id} and the calls behind the buttons.
 */
export function ServerDetailPage({ nodeId }: { nodeId: string }): React.JSX.Element {
  const s = useServer(nodeId);
  if (s.pending) return <PageSkeleton variant="kpis" />;
  if (!s.node || !s.server) {
    return <PageError title="Couldn’t find that server." error={s.error} retry={s.refetch} />;
  }
  const { node: n, server } = s;
  const hot = n.status === 'online' && server.diskPct !== null && server.diskPct >= DISK_HOT_PCT;
  const lede = [
    plainRoles(n).join(', '),
    `${n.resources.cpus ?? '—'} CPU`,
    `${gb(n.resources.memBytes)} memory`,
    server.live?.fsTotalBytes ? `${gb(server.live.fsTotalBytes)} disk` : null,
    server.monthlyUsd != null ? `$${server.monthlyUsd.toFixed(0)}/mo` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <CalmPage
      crumbs={[{ label: 'Servers', to: '/nodes' }, { label: n.name }]}
      aside={
        <>
          <ServerCode node={n} />
          <ServerInspector server={server} detail />
        </>
      }
    >
      <SayHeader
        eyebrow={[n.region, n.hostname].filter(Boolean).join(' · ')}
        title={
          <>
            {n.name} {STATE_SAY[n.status] ?? `is ${n.status}.`}
            {hot ? (
              <>
                {' '}
                <Say tone="warn">Its disk is {server.diskPct}% full.</Say>
              </>
            ) : null}
          </>
        }
        lede={lede}
        actions={
          <Button asChild variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/nodes/$nodeId/terminal" params={{ nodeId }}>
              <TerminalIcon className="size-4" /> Shell
            </Link>
          </Button>
        }
      />
      {hot ? <TidyUpNext server={server} here /> : null}
      <NodeRepairCard node={n} />
      <NodeSwarmJoinBanner node={n} />
      <Depth at="controls">
        <NodeLivePanel live={server.live} trend={s.trend} />
      </Depth>
      <NodeContainersPanel containers={s.containers} />
      <Depth at="controls">
        <NodeControlsPanel node={n} monthlyUsd={server.monthlyUsd} />
        <NodeHygienePanel nodeId={nodeId} />
        <NodeDisksCard nodeId={nodeId} online={n.status === 'online'} />
        <NodeOldCopiesCard nodeId={nodeId} />
      </Depth>
      <NodeRetirePanel nodeId={nodeId} />
    </CalmPage>
  );
}
