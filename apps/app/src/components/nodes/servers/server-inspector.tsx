import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth, StatusWord, Tech } from '@/components/calm';
import { NodeDangerControls } from '../node-danger-controls';
import { AgentVersionCell } from '../node-details-panel';
import { yours, type FleetView } from './fleet/fleet-model';
import { serverStory } from './fleet/server-story';
import { DISK_HOT_PCT, type FleetServer } from './use-fleet';
import { RunningHere } from './running-here';
import { ServerHistory } from './server-history';
import { ServerMeters } from './server-meters';
import { gb, plainRoles, serverTone, techRoles } from './server-words';

const MESH_WORD = { connected: 'On', joining: 'Joining', off: 'Not on it' } as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex items-baseline justify-between gap-4 border-b py-2 text-[13px] last:border-b-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right font-mono text-[12px] break-words">{children}</span>
    </div>
  );
}

/**
 * The selected server: its story, how full it is now and over the last
 * 24 hours, what runs there (each with a status dot, movable by admins),
 * and quiet actions. `view` is the map's model of it (story, private
 * network, services); without it (the server's own page) the short role
 * sentence stands in.
 */
export function ServerInspector({
  server,
  view,
  detail,
}: {
  server: FleetServer;
  view?: FleetView;
  /** On the server's own page: no "Open" link; its controls live in the main column. */
  detail?: boolean;
}): React.JSX.Element {
  const { node: n, live, diskPct } = server;
  const { tone, word } = serverTone(n);
  const hot = diskPct !== null && diskPct >= DISK_HOT_PCT;
  const roles = plainRoles(n);
  return (
    <section id="server-inspector" aria-label={`Server ${n.name}`} className="calm-card flex flex-col gap-4 px-5 py-5">
      <div className="flex flex-col gap-1">
        <span className="calm-eyebrow">{[n.region, roles[0]].filter(Boolean).join(' · ')}</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-display text-[1.45rem] font-bold tracking-[-0.02em]">{n.name}</h2>
          <StatusWord tone={hot ? 'warn' : tone} word={hot ? `Disk ${diskPct}%` : word} />
        </div>
        <p className="text-muted-foreground text-[13.5px] leading-relaxed">
          {view ? (
            serverStory({ node: n, rings: view.rings, nat: view.nat, mesh: view.mesh.state, yours: yours(view)?.length, diskHotPct: DISK_HOT_PCT })
          ) : (
            <>
              {roles.join(', ')}.
              {server.containers !== null ? ` ${server.containers} thing${server.containers === 1 ? '' : 's'} running here.` : ''}
              {hot ? ` Disk is ${diskPct}% full; tidying up frees the old images and leftovers.` : ''}
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col">
        <Fact label="Size">
          {n.resources.cpus ?? '—'} CPU · {gb(n.resources.memBytes)}
          {live?.fsTotalBytes ? ` · ${gb(live.fsTotalBytes)} disk` : ''}
        </Fact>
        {server.monthlyUsd != null ? <Fact label="Costs">${server.monthlyUsd.toFixed(0)}/mo</Fact> : null}
        {view ? <Fact label="Private network">{MESH_WORD[view.mesh.state]}</Fact> : null}
        <Depth at="controls">
          <Fact label="Public IP">{n.publicIp ?? (view?.nat ? 'none (behind NAT)' : 'none set')}</Fact>
          {view ? <Fact label="Mesh IP">{view.mesh.ip ?? '—'}</Fact> : null}
          <Fact label="Host">{n.hostname}</Fact>
          <Fact label="System">{[n.os, n.arch, n.engineVersion && `docker ${n.engineVersion}`].filter(Boolean).join(' · ') || '—'}</Fact>
          <Fact label="Agent">
            <AgentVersionCell node={n} />
          </Fact>
        </Depth>
      </div>
      <Tech>{techRoles(n)}</Tech>
      <div className="flex flex-col gap-2">
        <h3 className="calm-eyebrow">Now</h3>
        <ServerMeters live={live} />
      </div>
      <ServerHistory nodeId={n.id} />
      {detail ? null : (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="calm-eyebrow">Running here</h3>
            <RunningHere view={view} />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
              <Link to="/nodes/$nodeId" params={{ nodeId: n.id }}>
                Open {n.name} <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className="pointer-coarse:min-h-11">
              <Link to="/nodes/$nodeId/terminal" params={{ nodeId: n.id }}>
                <TerminalIcon className="size-4" /> Shell
              </Link>
            </Button>
          </div>
        </>
      )}
      {detail ? null : (
        <Depth at="controls">
          <div className="border-border border-t pt-4">
            <NodeDangerControls nodeId={n.id} name={n.name} status={n.status} role={n.role} agentRestart={n.agentRestart} />
          </div>
        </Depth>
      )}
    </section>
  );
}
