import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClockIcon, PlusIcon } from 'lucide-react';
import type { ScheduledJobView } from '@swarmy/core';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { DeleteJobDialog } from './delete-job-dialog';
import { JobDialog } from './job-dialog';
import { JobRunsDrawer } from './job-runs-drawer';
import { untilTime } from './job-status';
import { JobsTable } from './jobs-table';

/** The Jobs surface: cron table + editor dialog + run-history drawer. */
export function JobsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ScheduledJobView | null>(null);
  const [history, setHistory] = React.useState<ScheduledJobView | null>(null);
  const [deleting, setDeleting] = React.useState<ScheduledJobView | null>(null);

  const overview = useQuery({ ...trpc.jobs.overview.queryOptions(), refetchInterval: 5_000 });
  const jobs = useQuery({ ...trpc.jobs.list.queryOptions(), refetchInterval: 5_000 });

  const rows = jobs.data ?? [];
  const failed = overview.data?.failed24h ?? 0;
  const enabled = overview.data?.enabled ?? 0;
  const hero =
    failed > 0 ? (
      <>
        {failed} run{failed === 1 ? '' : 's'} <em>failed</em> today.
      </>
    ) : enabled > 0 ? (
      <>
        {enabled} job{enabled === 1 ? '' : 's'} <em>on schedule</em>.
      </>
    ) : (
      <>
        <em>Jobs</em>.
      </>
    );
  const nextUp =
    overview.data?.nextRunAt && overview.data.nextJobName
      ? `Next up: ${overview.data.nextJobName} ${untilTime(overview.data.nextRunAt)}.`
      : '';

  const newJob = (
    <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
      <PlusIcon className="size-4" /> New job
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Jobs"
        title={hero}
        description={`Cron-scheduled jobs that run as one-shot containers or exec into your services — with history and output. ${nextUp}`.trim()}
        actions={rows.length > 0 ? newJob : undefined}
      />

      {jobs.isLoading ? (
        <Card className="card-pop border-0">
          <CardContent className="grid gap-3 py-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </CardContent>
        </Card>
      ) : jobs.isError ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{jobs.error.message}</p>
            <Button variant="outline" onClick={() => void jobs.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<CalendarClockIcon />}
            title="No jobs yet"
            description="Schedule a job with cron and swarmy runs it on your nodes — output and history land here."
            action={newJob}
          />
        </div>
      ) : (
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <JobsTable
              jobs={rows}
              onHistory={setHistory}
              onEdit={(job) => { setEditing(job); setDialogOpen(true); }}
              onDelete={setDeleting}
            />
          </CardContent>
        </Card>
      )}

      <JobDialog open={dialogOpen} onOpenChange={setDialogOpen} job={editing} />
      <JobRunsDrawer job={history} onOpenChange={(open) => !open && setHistory(null)} />
      <DeleteJobDialog job={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}
