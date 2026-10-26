import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { nearestLink } from '@/components/networking/mesh-link-words';
import { useMeshLinks } from '@/components/networking/use-mesh-links';
import type { NodeRoleChoice } from './node-role-picker';
import type { AwaitedNode } from './use-await-node';

const GB = 1024 ** 3;

function Line({ ok = true, children, value }: { ok?: boolean; children: React.ReactNode; value?: React.ReactNode }): React.JSX.Element {
  return (
    <li className="border-border flex min-h-11 items-center gap-3 border-b py-2 text-[14px] last:border-b-0">
      <span aria-hidden className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-full', ok ? 'bg-tone-ok/15' : 'bg-tone-info/15')}>
        {ok ? <CheckIcon className="text-tone-ok size-3" /> : <span className="bg-status-progress size-1.5 rounded-full" />}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {value ? <span className="text-muted-foreground shrink-0 font-mono text-[12px]">{value}</span> : null}
    </li>
  );
}

/**
 * How it sits on the private network, from its live peer and its nearest
 * reported link ("· direct to home-lab", 0.4 ms); null when the network is off.
 */
function useMeshLine(nodeId: string): { ok: boolean; text: string; value?: string } | null {
  const trpc = useTRPC();
  const config = useQuery(trpc.mesh.getConfig.queryOptions());
  const on = !!config.data?.enabled && config.data.driver !== 'none';
  const peers = useQuery({ ...trpc.mesh.listPeers.queryOptions(), refetchInterval: 5_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const links = useMeshLinks(on, 5_000);
  if (!on) return null;
  const p = peers.data?.find((x) => x.nodeId === nodeId);
  if (p?.status !== 'CONNECTED') return { ok: false, text: p ? 'Joining the private network…' : 'Not on the private network yet' };
  const near = nearestLink(links ?? [], nodeId);
  if (near?.path) {
    const other = nodes.data?.find((x) => x.id === near.other)?.name ?? near.other;
    const how = near.path === 'direct' ? 'direct to' : 'through the relay to';
    return { ok: true, text: `Joined the private network · ${how} ${other}`, value: near.latency ?? undefined };
  }
  return { ok: true, text: `Joined the private network${p.relayed === false ? ' · direct' : p.relayed ? ' · through a relay' : ''}` };
}

/** The arrival receipt: when it phoned home, how it's on the private network, its role and size, then where to go. */
export function ArrivalReceipt({ arrived, role, onAnother }: { arrived: AwaitedNode; role: NodeRoleChoice; onAnother: () => void }): React.JSX.Element {
  const n = arrived.node;
  const mesh = useMeshLine(n.id);
  const size = [n.resources.cpus ? `${n.resources.cpus} cores` : null, n.resources.memBytes ? `${Math.round(n.resources.memBytes / GB)} GB` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex w-full flex-col gap-1">
      <h2 className="font-display text-[1.6rem] font-bold tracking-[-0.02em]">{n.name} is in.</h2>
      <ul className="flex flex-col">
        <Line value={arrived.at.toLocaleTimeString()}>Phoned home</Line>
        {mesh ? <Line ok={mesh.ok} value={mesh.value}>{mesh.text}</Line> : null}
        <Line value={size || undefined}>
          {role === 'auto' ? 'Automatic role' : 'Role'}: <b className="font-semibold">{n.role}</b>
        </Line>
      </ul>
      <div className="flex flex-wrap gap-2 pt-3">
        <Button asChild className="pointer-coarse:min-h-11">
          <Link to="/nodes">See it on the map</Link>
        </Button>
        <Button variant="outline" onClick={onAnother} className="pointer-coarse:min-h-11">
          Add another
        </Button>
        <Button asChild variant="outline" className="pointer-coarse:min-h-11">
          <Link to="/nodes">Move something onto it</Link>
        </Button>
      </div>
      <Tech className="pt-2">{[n.id, n.hostname, n.os, n.arch, n.agentVersion ? `agent ${n.agentVersion}` : null].filter(Boolean).join(' · ')}</Tech>
    </div>
  );
}
