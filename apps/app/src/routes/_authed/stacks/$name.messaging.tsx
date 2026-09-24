import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackJobsSection } from '@/components/jobs/stack-jobs-section';
import { StackQueuesSection } from '@/components/queues/stack-queues-section';
import { StackWebhooksSection } from '@/components/webhookgw/stack-webhooks-section';

/** Messaging tab: queues, webhooks & scheduled jobs for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/messaging')({
  component: MessagingTab,
});

function MessagingTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <div className="space-y-6">
      <StackQueuesSection stack={name} />
      <StackWebhooksSection stack={name} />
      <StackJobsSection stack={name} />
    </div>
  );
}
