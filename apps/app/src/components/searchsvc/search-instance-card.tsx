import * as React from 'react';
import { SearchIcon } from 'lucide-react';
import type { SearchInstanceView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { bytes } from '@/lib/format';

/** Instance health → status token (mirrors the cache-card semantics). */
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

/** One managed search instance in the list grid. Click opens the detail panel. */
export function SearchInstanceCard({
  view,
  onOpen,
}: {
  view: SearchInstanceView;
  onOpen: () => void;
}): React.JSX.Element {
  const { tone, label } = instanceTone(view);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card-pop card-pop-hover w-full p-5 text-left"
      aria-label={`Open search instance ${view.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <SearchIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{view.name}</p>
            <p className="mono-label text-muted-foreground !mb-0">
              {view.engine} · {view.stack}
            </p>
          </div>
        </div>
        <StatusBadge tone={tone} label={label} className="shrink-0" />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Documents</p>
          <p className="mono-data text-sm">
            {view.stats ? <CountUp value={view.stats.docs} /> : '—'}
          </p>
        </div>
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
            {view.engine === 'typesense' ? 'Collections' : 'Indexes'}
          </p>
          <p className="mono-data text-sm">
            {view.stats ? <CountUp value={view.stats.indexes} /> : '—'}
          </p>
        </div>
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
            {view.engine === 'typesense' ? 'Memory' : 'DB size'}
          </p>
          <p className="mono-data text-sm">{engineSize(view)}</p>
        </div>
      </div>

      {view.attachments.length > 0 ? (
        <p className="text-muted-foreground mt-3 truncate text-xs">
          Attached: {view.attachments.map((a) => a.service).join(', ')}
        </p>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">No apps attached yet.</p>
      )}
    </button>
  );
}
