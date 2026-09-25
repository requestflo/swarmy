import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FastForwardIcon, PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { Button, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { JobList } from './job-list';
import { QueueCleanBar } from './queue-clean';
import { QueueRates } from './queue-rates';
import { STUDIO_STATES, stateCount, type StudioQueue, type StudioRef, type StudioState } from './studio-types';

/** One queue: counts by state, actions, rates, and the job browser. */
export function QueueDetail({ studio, queue }: { studio: StudioRef; queue: StudioQueue }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [state, setState] = React.useState<StudioState>(queue.counts.failed > 0 ? 'failed' : 'wait');
  const ref = { ...studio, queue: queue.name };
  const done = (msg: string): void => {
    toast.success(msg);
    void qc.invalidateQueries();
  };
  const onError = (e: { message: string }) => toast.error(e.message);

  const pause = useMutation(trpc.queues.studioPause.mutationOptions({ onSuccess: (r) => done(r.message), onError }));
  const retryAll = useMutation(trpc.queues.studioRetryAll.mutationOptions({ onSuccess: (r) => done(r.message), onError }));
  const promoteAll = useMutation(
    trpc.queues.studioPromoteAll.mutationOptions({ onSuccess: (r) => done(r.message), onError }),
  );

  return (
    <section aria-label={`Queue ${queue.name}`} className="calm-card min-w-0 space-y-5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="mono-data truncate text-xl font-semibold">{queue.name}</h2>
          <p className="text-muted-foreground text-xs">
            {queue.jobsTotal.toLocaleString()} jobs ever added
            {queue.rate
              ? ` · ${queue.rate.throughput}/min done · ${queue.rate.failureRate}/min failed${
                  queue.rate.failureRatio != null ? ` (${Math.round(queue.rate.failureRatio * 100)}%)` : ''
                }`
              : ' · rates after the next two samples'}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pause.isPending}
          onClick={() => pause.mutate({ ...ref, paused: !queue.isPaused })}
        >
          {queue.isPaused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
          {queue.isPaused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          size="sm"
          variant={queue.counts.failed > 0 ? 'default' : 'outline'}
          disabled={retryAll.isPending || queue.counts.failed === 0}
          onClick={() => retryAll.mutate({ ...ref, from: 'failed' })}
        >
          <RotateCcwIcon className="size-3.5" /> Retry all {queue.counts.failed > 0 ? queue.counts.failed.toLocaleString() : ''} failed
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={promoteAll.isPending || queue.counts.delayed === 0}
          onClick={() => promoteAll.mutate(ref)}
        >
          <FastForwardIcon className="size-3.5" /> Promote delayed
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
        {STUDIO_STATES.map((s) => {
          const n = stateCount(queue, s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={state === s.id}
              onClick={() => setState(s.id)}
              className={cn(
                'hover:bg-muted/40 rounded-lg border px-2 py-1.5 text-left transition-colors',
                state === s.id ? 'border-foreground/40 bg-foreground/[0.05]' : 'border-border',
              )}
            >
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{s.label}</p>
              <p className={cn('mono-data text-base', s.id === 'failed' && n > 0 && 'text-tone-bad font-semibold')}>
                {n.toLocaleString()}
              </p>
            </button>
          );
        })}
      </div>

      <QueueRates studio={studio} queue={queue.name} />

      <JobList studio={studio} queue={queue.name} state={state} />

      <QueueCleanBar studio={studio} queue={queue} state={state} />
    </section>
  );
}
