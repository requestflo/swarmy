import * as React from 'react';
import { BoxIcon, ChevronDownIcon } from 'lucide-react';
import type { VectorInstanceView } from '@swarmy/core';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  StatusBadge,
  type StatusTone,
  cn,
} from '@swarmy/ui';
import { VectorRowDetail } from './vector-row-detail';

/** Instance health → status token (mirrors the cache/search row semantics). */
export function vectorTone(view: VectorInstanceView): { tone: StatusTone; label: string } {
  if (view.status === 'absent') return { tone: 'offline', label: 'absent' };
  if (view.status === 'stopped' || view.running < 1) return { tone: 'offline', label: 'down' };
  if (view.status === 'deploying') return { tone: 'progress', label: 'deploying' };
  return { tone: 'online', label: 'healthy' };
}

/**
 * One managed qdrant instance as a flat row (hairline dividers come from the
 * parent list). Clicking expands the full detail inline — never a Sheet.
 */
export function VectorRow({ view }: { view: VectorInstanceView }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const { tone, label } = vectorTone(view);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/30 -mx-2 flex w-full items-center gap-3 rounded-md px-2 py-3 text-left"
          aria-label={`${open ? 'Collapse' : 'Expand'} vector store ${view.name}`}
        >
          <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
            <BoxIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{view.name}</p>
            <p className="mono-label text-muted-foreground !mb-0">qdrant</p>
          </div>
          <div className="hidden shrink-0 gap-5 text-right md:flex">
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Collections</p>
              <p className="mono-data text-sm">{view.stats ? view.stats.collections : '—'}</p>
            </div>
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Replicas</p>
              <p className="mono-data text-sm">
                {view.running}
                <span className="text-muted-foreground"> / {view.desired}</span>
              </p>
            </div>
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Apps</p>
              <p className="mono-data text-sm">{view.attachments.length}</p>
            </div>
          </div>
          <StatusBadge tone={tone} label={label} className="shrink-0" />
          <ChevronDownIcon
            className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <VectorRowDetail view={view} onDestroyed={() => setOpen(false)} />
      </CollapsibleContent>
    </Collapsible>
  );
}
