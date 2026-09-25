import * as React from 'react';
import { CalmBadge } from '@/components/stack-data/calm-badge';
import { ChevronDownIcon, ZapIcon } from 'lucide-react';
import type { CacheClusterView } from '@swarmy/core';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  type StatusTone,
  cn,
} from '@swarmy/ui';
import { bytes } from '@/lib/format';
import { CalmRow } from '@/components/calm';
import { CacheRowDetail } from './cache-row-detail';

/** Cluster health → status token (mirrors the db-cluster panel semantics). */
export function clusterTone(view: CacheClusterView): { tone: StatusTone; label: string } {
  if (view.primary.status === 'absent') return { tone: 'offline', label: 'absent' };
  if (view.primary.status === 'stopped') return { tone: 'offline', label: 'down' };
  if (view.primary.status === 'failing') return { tone: 'offline', label: 'failing' };
  if (view.primary.status === 'deploying') return { tone: 'progress', label: 'deploying' };
  const replicasOk = view.replicas.running >= view.replicas.desired;
  if (view.primary.status === 'running' && replicasOk) return { tone: 'online', label: 'healthy' };
  return { tone: 'warning', label: 'degraded' };
}

/**
 * One managed cache cluster as a flat row (hairline dividers come from the
 * parent list). Clicking expands the full detail inline — never a Sheet.
 */
export function CacheRow({ view }: { view: CacheClusterView }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const { tone, label } = clusterTone(view);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/30 -mx-2 flex w-full items-center gap-3 rounded-md px-2 py-3 text-left"
          aria-label={`${open ? 'Collapse' : 'Expand'} cache cluster ${view.name}`}
        >
          <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
            <ZapIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{view.name}</p>
            <p className="mono-label text-muted-foreground !mb-0">
              {view.engine} · {view.topology}
            </p>
          </div>
          <div className="hidden shrink-0 gap-5 text-right md:flex">
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Memory</p>
              <p className="mono-data text-sm">
                {view.stats ? bytes(view.stats.usedMemoryBytes) : '—'}
              </p>
            </div>
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Replicas</p>
              <p className="mono-data text-sm">
                {view.replicas.running}
                <span className="text-muted-foreground"> / {view.replicas.desired}</span>
              </p>
            </div>
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Apps</p>
              <p className="mono-data text-sm">{view.attachments.length}</p>
            </div>
          </div>
          <CalmBadge tone={tone} label={label} className="shrink-0" />
          <ChevronDownIcon
            className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CacheRowDetail view={view} onDestroyed={() => setOpen(false)} />
      </CollapsibleContent>
    </Collapsible>
  );
}

const CALM_TONE = { online: 'ok', warning: 'warn', offline: 'bad', progress: 'info', neutral: 'idle' } as const;

/** Plain words for a cache: what it holds, how full, who uses it. */
export function cacheSentence(view: CacheClusterView): string {
  const copies = view.replicas.running + 1;
  const where = copies > 1 ? `on ${copies} servers` : 'on one server';
  const fill = view.stats ? `${bytes(view.stats.usedMemoryBytes)} of ${view.memoryMb} MB used` : `up to ${view.memoryMb} MB`;
  const who = view.attachments.length ? `Used by ${view.attachments.map((a) => a.service.split('_').pop()).join(', ')}.` : 'No app uses it yet.';
  return `Kept in memory ${where}, ${fill}. ${who}`;
}

/** The Summary-depth row for a cache (no knobs; Controls shows `CacheRow`). */
export function CacheSummaryRow({ view }: { view: CacheClusterView }): React.JSX.Element {
  const { tone, label } = clusterTone(view);
  return (
    <CalmRow
      tone={CALM_TONE[tone]}
      name={view.name}
      sub={view.engine}
      say={cacheSentence(view)}
      word={tone === 'online' ? 'Online' : label}
    />
  );
}
