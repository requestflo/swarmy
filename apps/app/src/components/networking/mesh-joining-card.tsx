import * as React from 'react';
import { CheckIcon, LoaderCircleIcon } from 'lucide-react';
import type { NodeSummary } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { JOINING_STATUSES, type MeshPeerLike } from './mesh-graph-model';

/** The joining ladder: ENROLLING → ENROLLED → CONNECTED, one step each. */
const STEPS = [
  { label: 'One-time key', active: 'Starting the private-network client with a one-time key', done: 'Client started with a single-use key' },
  { label: 'Joining', active: 'Client is up, finding a way to the other servers', done: 'On the private network' },
  { label: 'Connected', active: 'Waiting for the first link', done: 'Talking to the others, encrypted end to end' },
];

/** How many steps are done for a peer status (CONNECTED = all three). */
export function stepsDone(status: string): number {
  return status === 'ENROLLING' ? 0 : status === 'ENROLLED' ? 1 : status === 'CONNECTED' ? 3 : 0;
}

/** "Joining now": the server on its way in, step by step, from its live peer status. */
export function MeshJoiningCard({ peers, nodes }: { peers: MeshPeerLike[]; nodes: NodeSummary[] }): React.JSX.Element | null {
  const joining = peers.filter((p) => JOINING_STATUSES.has(p.status));
  const p = joining[0];
  if (!p) return null;
  const node = nodes.find((n) => n.id === p.nodeId);
  const done = stepsDone(p.status);
  const machine = [node?.os, node?.arch].filter(Boolean).join(' · ');
  return (
    <section aria-label="Joining now" aria-live="polite" className="calm-card flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="calm-eyebrow">Joining now</span>
        {machine ? <span className="text-muted-foreground ml-auto font-mono text-[11px]">{machine}</span> : null}
      </div>
      <h2 className="font-display text-[1.35rem] font-bold tracking-[-0.02em]">{node?.name ?? p.nodeId}</h2>
      <div aria-hidden className="flex h-1.5 gap-1">
        {STEPS.map((s, i) => (
          <span key={s.label} className={cn('flex-1 rounded-sm', i < done ? 'bg-status-online' : i === done ? 'bg-primary' : 'bg-muted')} />
        ))}
      </div>
      <ol className="flex flex-col">
        {STEPS.map((s, i) => {
          const isDone = i < done;
          const isActive = i === done;
          return (
            <li key={s.label} className="flex items-center gap-2.5 py-1.5">
              <span
                aria-hidden
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px]',
                  isDone ? 'border-tone-ok bg-tone-ok/15' : isActive ? 'border-primary' : 'border-border',
                )}
              >
                {isDone ? <CheckIcon className="text-tone-ok size-3" /> : null}
                {isActive ? <LoaderCircleIcon className="text-primary size-3 motion-safe:animate-spin" /> : null}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={cn('text-[13.5px]', isDone || isActive ? 'font-semibold' : 'text-muted-foreground')}>{s.label}</span>
                <span className="text-muted-foreground text-xs">
                  {isDone ? (i === 1 && p.meshIp ? `${s.done} at ${p.meshIp}` : s.done) : isActive ? s.active : 'next'}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {joining.length > 1 ? <p className="text-muted-foreground text-xs">and {joining.length - 1} more joining</p> : null}
      <Tech>{`mesh peer ${p.status}${p.lastSeen ? ` · last heard ${new Date(p.lastSeen).toLocaleTimeString()}` : ''}`}</Tech>
    </section>
  );
}
