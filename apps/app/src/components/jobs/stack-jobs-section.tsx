import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
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
    <Section
      title="Scheduled jobs"
      count={jobs.data ? rows.length : undefined}
      hint={subtitle}
      flush
      action={
        <Depth at="controls">
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setCreating((v) => !v)}>
            <PlusIcon className="size-3.5" /> Add a job
          </Button>
        </Depth>
      }
    >
        <Collapsible open={creating} onOpenChange={setCreating}>
          <CollapsibleContent>
            <div className="border-border mb-3 rounded-xl border p-4">
              <JobEditInline stack={stack} job={null} onDone={() => setCreating(false)} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {jobs.isPending ? (
          <RowsSkeleton rows={2} />
        ) : jobs.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-tone-bad text-sm">{jobs.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">
            No jobs yet. Schedule one and it runs as a one-off copy of a service, with its output kept here.
          </p>
        ) : (
          <JobsTable stack={stack} jobs={rows} />
        )}
    </Section>
  );
}
