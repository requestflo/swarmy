import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { JobsPage } from '@/components/jobs/jobs-page';

export const Route = createFileRoute('/_authed/jobs')({
  component: JobsRoute,
});

function JobsRoute(): React.JSX.Element {
  return <JobsPage />;
}
