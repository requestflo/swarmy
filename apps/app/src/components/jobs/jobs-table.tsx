import * as React from 'react';
import type { ScheduledJobView } from '@swarmy/core';
import { JobRow } from './job-row';

/** Flat rows in one card, divided by hairlines (never per-row cards). */
export function JobsTable({
  stack,
  jobs,
}: {
  stack: string;
  jobs: ScheduledJobView[];
}): React.JSX.Element {
  return (
    <div className="divide-border divide-y">
      <div className="mono-label text-muted-foreground hidden gap-x-4 px-4 py-2 sm:grid sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_8rem_9rem_auto]">
        <span>Job</span>
        <span>Schedule</span>
        <span>Last run</span>
        <span>Next run</span>
        <span className="text-right">Actions</span>
      </div>
      {jobs.map((job) => (
        <JobRow key={job.id} stack={stack} job={job} />
      ))}
    </div>
  );
}
