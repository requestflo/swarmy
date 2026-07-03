import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClockIcon, PlusIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { JobEditInline } from './job-edit-inline';
import { untilTime } from './job-status';
import { JobsTable } from './jobs-table';

/**
 * Scheduled jobs section of the stack Messaging tab: this stack's cron jobs
 * as flat rows (row-expand for history/edit), plus the inline create form.
 */
export function StackJobsSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);

  const overview = useQuery({
    ...trpc.jobs.overview.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const jobs = useQuery({
    ...trpc.jobs.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = jobs.data ?? [];
  const failed = overview.data?.failed24h ?? 0;
  const subtitle =
    failed > 0
      ? `${failed} run${failed === 1 ? '' : 's'} failed today`
      : overview.data?.nextRunAt && overview.data.nextJobName
        ? `next: ${overview.data.nextJobName} ${untilTime(overview.data.nextRunAt)}`
        : 'cron, one-shot containers & execs';

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <CalendarClockIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">Scheduled jobs</h3>
              <p className="text-muted-foreground mono-label !mb-0">{subtitle}</p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="shrink-0">
                <PlusIcon className="size-4" /> New job
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
              <JobEditInline stack={stack} job={null} onDone={() => setCreating(false)} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {jobs.isLoading ? (
          <div className="space-y-2">
            <div className="shimmer-line h-12 rounded-lg" />
            <div className="shimmer-line h-12 rounded-lg" />
          </div>
        ) : jobs.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-status-offline text-sm">{jobs.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<CalendarClockIcon />}
            title={`No jobs in ${stack} yet — schedule one.`}
            description="Cron-scheduled jobs run as one-shot containers or exec into your services — with history and output, right here."
            action={
              <Button variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> New job
              </Button>
            }
          />
        ) : (
          <JobsTable stack={stack} jobs={rows} />
        )}
      </CardContent>
    </Card>
  );
}
