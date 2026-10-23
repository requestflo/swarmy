import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { TopologyConfirm } from './topology-confirm';
import { TopologyDiagram } from './topology-diagram';
import { TOPOLOGY_LABEL, topologyView, type Topology } from './topology-model';

const MODES: Topology[] = ['controller', 'edge-per-node'];

/**
 * Board 31's topology: pick "One edge" or "An edge on every edge server",
 * the picture morphs to show it, and Switch over / Keep current decides.
 */
export function TopologySection({
  current,
  nodes,
  targetNodes,
  geo,
  apps,
  bucket,
  objectStorage,
  sharedCertsPending,
  admin,
}: {
  current: Topology;
  nodes: NodeSummary[] | undefined;
  targetNodes: string[];
  geo: boolean;
  apps: string[];
  bucket: string | null;
  objectStorage: boolean;
  /** Edge-per-node while the shared certificate store isn't set up yet. */
  sharedCertsPending: boolean;
  admin: boolean | undefined;
}): React.JSX.Element {
  const [pending, setPending] = React.useState<Topology | null>(null);
  const shown = pending ?? current;
  const view = nodes ? topologyView({ mode: shown, nodes, targetNodes, geo, apps, bucket }) : null;
  return (
    <Section title="Topology" hint={pending ? 'previewing, nothing has changed yet' : undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="radiogroup" aria-label="Edge topology" className="border-border bg-background inline-flex max-w-full flex-wrap gap-0.5 rounded-[10px] border p-0.5">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={shown === m}
              onClick={() => setPending(m === current ? null : m)}
              className={cn(
                'h-8 rounded-[8px] px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
                shown === m ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {TOPOLOGY_LABEL[m]}
              {m === current ? <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">now</span> : null}
            </button>
          ))}
        </div>
        {view ? <p className="text-muted-foreground max-w-[560px] flex-1 text-[13px] leading-snug">{view.hint}</p> : null}
      </div>
      {pending ? (
        <TopologyConfirm next={pending} admin={admin} objectStorage={objectStorage} anyEdge={!!nodes?.some((n) => n.ingress)} onDone={() => setPending(null)} />
      ) : null}
      {current === 'edge-per-node' && sharedCertsPending && !pending ? (
        <p className="text-tone-warn text-[13px]">
          {objectStorage
            ? 'Setting up the shared certificates in swarmy object storage. This finishes on its own within a minute.'
            : 'Each edge is issuing its own certificates, so a new domain’s first certificate can fail. Turn on object storage so every edge shares one set.'}
        </p>
      ) : null}
      {view ? <TopologyDiagram view={view} preview={!!pending} /> : <CardSkeleton lines={3} className="border-0 p-0" />}
    </Section>
  );
}
