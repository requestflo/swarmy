import * as React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import type { QueueView } from '@swarmy/core';
import { StatusBadge, cn, type StatusTone } from '@swarmy/ui';

/** Health tone for one queue row (failed > backlog > worker health). */
export function queueTone(q: QueueView): { tone: StatusTone; label: string } {
  if (!q.cacheOnline) return { tone: 'offline', label: 'cache down' };
  if ((q.stats?.failed ?? 0) > 0) return { tone: 'warning', label: `${q.stats?.failed} failed` };
  if (q.workers.running < Math.min(q.workers.desired, q.minWorkers)) {
    return { tone: 'progress', label: 'scaling' };
  }
  return { tone: 'online', label: 'healthy' };
}

function Num({ value, warn }: { value: number | undefined; warn?: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'mono-data text-sm tabular-nums',
        warn && (value ?? 0) > 0 ? 'text-status-offline font-semibold' : undefined,
        value === undefined ? 'text-muted-foreground' : undefined,
      )}
    >
      {value === undefined ? '—' : value.toLocaleString()}
    </span>
  );
}

/** Flat queue rows in one card: name, backend, depths, workers, health. */
export function QueuesTable({
  queues,
  onOpen,
}: {
  queues: QueueView[];
  onOpen: (q: QueueView) => void;
}): React.JSX.Element {
  return (
    <div className="card-pop overflow-hidden">
      <div className="text-muted-foreground mono-label hidden grid-cols-[1.6fr_1fr_repeat(3,4.5rem)_6rem_7rem_1.5rem] items-center gap-3 border-b border-border px-5 py-2.5 !text-[10px] lg:grid">
        <span>Queue</span>
        <span>Backend</span>
        <span className="text-right">Waiting</span>
        <span className="text-right">Active</span>
        <span className="text-right">Failed</span>
        <span className="text-right">Workers</span>
        <span className="text-right">Health</span>
        <span />
      </div>
      <div className="divide-border divide-y">
        {queues.map((q) => {
          const tone = queueTone(q);
          return (
            <button
              key={`${q.workerService}/${q.name}`}
              type="button"
              onClick={() => onOpen(q)}
              className="hover:bg-accent/50 grid w-full grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 text-left transition-colors lg:grid-cols-[1.6fr_1fr_repeat(3,4.5rem)_6rem_7rem_1.5rem]"
            >
              <span className="min-w-0">
                <span className="mono-data block truncate text-sm font-semibold">{q.name}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {q.workerService}
                </span>
              </span>
              <span className="hidden min-w-0 lg:block">
                <span className="block truncate text-xs">{q.cacheStack}/{q.cacheName}</span>
                <span className="mono-label text-muted-foreground !mb-0 !text-[10px]">
                  {q.convention === 'bullmq' ? 'BullMQ' : 'raw list'}
                </span>
              </span>
              <span className="hidden text-right lg:block"><Num value={q.stats?.wait} /></span>
              <span className="hidden text-right lg:block"><Num value={q.stats?.active} /></span>
              <span className="hidden text-right lg:block"><Num value={q.stats?.failed} warn /></span>
              <span className="mono-data hidden text-right text-sm lg:block">
                {q.workers.running}/{q.maxWorkers}
              </span>
              <span className="hidden justify-end lg:flex">
                <StatusBadge tone={tone.tone} label={tone.label} />
              </span>
              <span className="flex items-center justify-end gap-3 lg:hidden">
                <span className="text-right">
                  <Num value={q.stats?.wait} />
                  <span className="text-muted-foreground text-xs"> waiting</span>
                </span>
                <StatusBadge tone={tone.tone} label={tone.label} />
              </span>
              <ChevronRightIcon className="text-muted-foreground hidden size-4 justify-self-end lg:block" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
