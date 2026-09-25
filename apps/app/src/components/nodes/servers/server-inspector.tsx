import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth, StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { NodeDangerControls } from '../node-danger-controls';
import { DISK_HOT_PCT, type FleetServer } from './use-fleet';
import { ServerMeters } from './server-meters';
import { gb, plainRoles, serverTone, techRoles } from './server-words';

/** What runs on a server, as short names ("storefront_web.1.x" → "storefront_web"). */
function RunningHere({ nodeId }: { nodeId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.nodes.containers.queryOptions({ nodeId }), refetchInterval: 10_000 });
  const names = [...new Set((q.data ?? []).map((c: { name: string }) => c.name.replace(/^\//, '').split('.')[0]!))];
  if (q.isPending) return <span className="shimmer-line block h-6 w-2/3 rounded-md" />;
  if (names.length === 0) return <p className="text-muted-foreground text-[13px]">Nothing runs here right now.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {names.slice(0, 10).map((n) => (
        <li key={n} className="bg-foreground/[0.05] rounded-md px-2 py-1 font-mono text-[11.5px]">
          {n}
        </li>
      ))}
      {names.length > 10 ? <li className="text-muted-foreground px-1 py-1 text-xs">+{names.length - 10} more</li> : null}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex items-baseline justify-between gap-4 border-b py-2 text-[13px] last:border-b-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right font-mono text-[12px] break-words">{children}</span>
    </div>
  );
}

/** The selected server: what it does, how full it is, what runs there, and quiet actions. */
export function ServerInspector({ server }: { server: FleetServer }): React.JSX.Element {
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
          {roles.join(', ')}.
          {server.containers !== null ? ` ${server.containers} thing${server.containers === 1 ? '' : 's'} running here.` : ''}
          {hot ? ` Disk is ${diskPct}% full; tidying up frees the old images and leftovers.` : ''}
        </p>
      </div>
      <div className="flex flex-col">
        <Fact label="Size">
          {n.resources.cpus ?? '—'} CPU · {gb(n.resources.memBytes)}
          {live?.fsTotalBytes ? ` · ${gb(live.fsTotalBytes)} disk` : ''}
        </Fact>
        {server.monthlyUsd != null ? <Fact label="Costs">${server.monthlyUsd.toFixed(0)}/mo</Fact> : null}
        <Depth at="controls">
          <Fact label="Public IP">{n.publicIp ?? 'none set'}</Fact>
          <Fact label="Host">{n.hostname}</Fact>
          <Fact label="System">{[n.os, n.arch, n.engineVersion && `docker ${n.engineVersion}`].filter(Boolean).join(' · ') || '—'}</Fact>
          <Fact label="Agent">{n.agentVersion ?? '—'}</Fact>
        </Depth>
      </div>
      <Tech>{techRoles(n)}</Tech>
      <div className="flex flex-col gap-2">
        <h3 className="calm-eyebrow">Now</h3>
        <ServerMeters live={live} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="calm-eyebrow">Running here</h3>
        <RunningHere nodeId={n.id} />
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
      <Depth at="controls">
        <div className="border-border border-t pt-4">
          <NodeDangerControls nodeId={n.id} name={n.name} status={n.status} role={n.role} />
        </div>
      </Depth>
    </section>
  );
}
