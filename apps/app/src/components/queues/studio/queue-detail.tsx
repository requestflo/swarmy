import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FastForwardIcon, PauseIcon, PlayIcon, RotateCcwIcon, SparklesIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AreaTrend } from '@/components/charts';
import { JobList } from './job-list';
import { STUDIO_STATES, stateCount, type StudioQueue, type StudioRef, type StudioState } from './studio-types';

const CLEANABLE: StudioState[] = ['completed', 'failed', 'wait', 'delayed', 'prioritized', 'paused'];
const GRACE: { label: string; ms: number }[] = [
  { label: 'all', ms: 0 },
  { label: 'older than 1h', ms: 3_600_000 },
  { label: 'older than 24h', ms: 86_400_000 },
  { label: 'older than 7d', ms: 7 * 86_400_000 },
];

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
  const clean = useMutation(trpc.queues.studioClean.mutationOptions({ onSuccess: (r) => done(r.message), onError }));
  const [grace, setGrace] = React.useState('0');

  const rates = useQuery({
    ...trpc.queues.studioRates.queryOptions({ ...ref, windowMinutes: 60 }),
    refetchInterval: 30_000,
    retry: false,
  });
  const series = (rates.data?.points ?? []).map((p) => ({
    t: p.bucket,
    throughput: p.seconds > 0 ? Math.round((p.completed / p.seconds) * 60 * 10) / 10 : 0,
    failures: p.seconds > 0 ? Math.round((p.failed / p.seconds) * 60 * 10) / 10 : 0,
  }));

  const cleanable = CLEANABLE.includes(state);

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

      {rates.data?.status === 'ok' && series.length > 1 ? (
        <div>
          <p className="mono-label text-muted-foreground !mb-1">Last hour · jobs/min</p>
          <AreaTrend
            data={series}
            height={140}
            series={[
              { key: 'throughput', label: 'done/min', color: 'var(--color-status-online)' },
              { key: 'failures', label: 'failed/min', color: 'var(--color-status-offline)' },
            ]}
          />
        </div>
      ) : rates.data?.status === 'disabled' ? (
        <p className="text-muted-foreground text-[11px]">
          Turn on Observability to keep throughput and failure-rate history.
        </p>
      ) : null}

      <JobList studio={studio} queue={queue.name} state={state} />

      {cleanable && stateCount(queue, state) > 0 ? (
        <div className="border-border flex flex-wrap items-center gap-2 border-t pt-4">
          <SparklesIcon className="text-muted-foreground size-4" />
          <p className="text-sm">Clean {STUDIO_STATES.find((s) => s.id === state)?.label.toLowerCase()} jobs</p>
          <Select value={grace} onValueChange={setGrace}>
            <SelectTrigger aria-label="Which jobs to clean" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRACE.map((g) => (
                <SelectItem key={g.ms} value={String(g.ms)}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="text-tone-bad border-status-offline/40 hover:bg-status-offline/10"
                disabled={clean.isPending}
              >
                Clean
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {state} jobs on {queue.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Removes up to 1,000 jobs (and their data and logs) in this state
                  {grace !== '0' ? `, ${GRACE.find((g) => String(g.ms) === grace)?.label}` : ''}. This can’t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    clean.mutate({
                      ...ref,
                      state: state as 'completed' | 'failed' | 'wait' | 'delayed' | 'prioritized' | 'paused',
                      graceMs: Number(grace),
                      limit: 1000,
                    })
                  }
                >
                  Clean
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
    </section>
  );
}
