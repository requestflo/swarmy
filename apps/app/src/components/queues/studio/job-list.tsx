import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Progress, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { JobDetail } from './job-detail';
import { attempts, msTime, progressPct, type BullJobRow, type StudioRef, type StudioState } from './studio-types';

const PAGE = 25;

/** A page of jobs in one state as flat rows. A row expands inline to the job detail. */
export function JobList({ studio, queue, state }: { studio: StudioRef; queue: string; state: StudioState }): React.JSX.Element {
  const trpc = useTRPC();
  const [start, setStart] = React.useState(0);
  React.useEffect(() => setStart(0), [state, queue]);

  const jobs = useQuery({
    ...trpc.queues.studioJobs.queryOptions({ ...studio, queue, state, start, count: PAGE }),
    refetchInterval: 5_000,
    retry: false,
  });

  if (jobs.isLoading) return <CardSkeleton lines={5} />;
  if (jobs.isError) return <ErrorState title="Couldn’t list jobs." error={jobs.error} retry={() => void jobs.refetch()} />;
  const page = jobs.data!;
  const rows = page.jobs as BullJobRow[];

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">Nothing {state} right now.</p>
      ) : (
        <div className="divide-border divide-y">
          {rows.map((j) => (
            <JobRow key={j.id} studio={studio} queue={queue} state={state} job={j} />
          ))}
        </div>
      )}
      {page.total > PAGE ? (
        <div className="flex items-center justify-end gap-2">
          <p className="text-muted-foreground mono-data text-xs">
            {start + 1}–{Math.min(start + PAGE, page.total)} of {page.total.toLocaleString()}
          </p>
          <Button size="sm" variant="ghost" aria-label="Newer jobs" disabled={start === 0} onClick={() => setStart(Math.max(0, start - PAGE))}>
            <ChevronLeftIcon className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Older jobs" disabled={start + PAGE >= page.total} onClick={() => setStart(start + PAGE)}>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JobRow({
  studio,
  queue,
  state,
  job,
}: {
  studio: StudioRef;
  queue: string;
  state: StudioState;
  job: BullJobRow;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const pct = progressPct(job.progress);
  if (job.missing) {
    return <p className="text-muted-foreground mono-data py-2 text-xs">#{job.id} — gone (removed while listing)</p>;
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="hover:bg-muted/30 -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left">
          <span className="mono-data text-muted-foreground w-14 shrink-0 truncate text-xs">#{job.id}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{job.name ?? '—'}</p>
            <p className="text-muted-foreground mono-data truncate text-[11px]">
              {state === 'failed' && job.failedReason ? job.failedReason : (job.data ?? '').slice(0, 140)}
            </p>
          </div>
          {pct != null && state === 'active' ? <Progress value={pct} className="hidden w-20 sm:block" /> : null}
          <div className="hidden shrink-0 text-right sm:block">
            <p className="mono-data text-xs">{attempts(job)} tries</p>
            <p className="text-muted-foreground text-[11px]">
              {state === 'delayed' && job.runAt ? `runs ${new Date(job.runAt).toLocaleTimeString()}` : msTime(job.finishedOn ?? job.timestamp)}
            </p>
          </div>
          <ChevronDownIcon className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open ? <JobDetail studio={studio} queue={queue} id={job.id} onGone={() => setOpen(false)} /> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
