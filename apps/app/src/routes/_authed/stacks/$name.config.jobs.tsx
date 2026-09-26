import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { JobsTab } from '@/components/app-tabs/jobs/jobs-tab';

/** Config › Jobs & previews: scheduled jobs, webhooks and branch previews. */
export const Route = createFileRoute('/_authed/stacks/$name/config/jobs')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <JobsTab stack={name} />;
}
