import * as React from 'react';
import { ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { SearchInstanceView } from '@swarmy/core';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  StatusBadge,
  type StatusTone,
  cn,
} from '@swarmy/ui';
import { bytes } from '@/lib/format';
import { SearchRowDetail } from './search-row-detail';

/** Instance health → status token (mirrors the cache-row semantics). */
export function instanceTone(view: SearchInstanceView): { tone: StatusTone; label: string } {
  if (view.status === 'absent') return { tone: 'offline', label: 'absent' };
  if (view.status === 'stopped') return { tone: 'offline', label: 'down' };
  if (view.status === 'deploying') return { tone: 'progress', label: 'deploying' };
  if (view.status === 'running' && view.running >= view.desired)
    return { tone: 'online', label: 'healthy' };
  return { tone: 'warning', label: 'degraded' };
}

/** Human size for the engine: meilisearch db size, typesense memory. */
export function engineSize(view: SearchInstanceView): string {
  const n = view.stats?.dbSizeBytes ?? view.stats?.memoryBytes;
  return typeof n === 'number' ? bytes(n) : '—';
}

/**
 * One managed search instance as a flat row (hairline dividers come from the
 * parent list). Clicking expands the full detail inline — never a Sheet.
 */
export function SearchRow({ view }: { view: SearchInstanceView }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const { tone, label } = instanceTone(view);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/30 -mx-2 flex w-full items-center gap-3 rounded-md px-2 py-3 text-left"
          aria-label={`${open ? 'Collapse' : 'Expand'} search instance ${view.name}`}
        >
          <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
            <SearchIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{view.name}</p>
            <p className="mono-label text-muted-foreground !mb-0">{view.engine}</p>
          </div>
          <div className="hidden shrink-0 gap-5 text-right md:flex">
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Documents</p>
              <p className="mono-data text-sm">
                {view.stats ? view.stats.docs.toLocaleString() : '—'}
              </p>
            </div>
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
                {view.engine === 'typesense' ? 'Memory' : 'DB size'}
              </p>
              <p className="mono-data text-sm">{engineSize(view)}</p>
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
        <SearchRowDetail view={view} onDestroyed={() => setOpen(false)} />
      </CollapsibleContent>
    </Collapsible>
  );
}
