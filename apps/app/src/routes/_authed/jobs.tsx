import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CalendarClockIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/jobs')({
  component: JobsPage,
});

function JobsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Jobs"
        title={
          <>
            <em>Jobs</em>.
          </>
        }
        description="Cron-scheduled jobs that run as one-shot containers or exec into your services — with history and output."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<CalendarClockIcon />}
          title="No jobs yet"
          description="Schedule a job with cron and swarmy runs it on your nodes — output and history land here."
        />
      </div>
    </div>
  );
}
