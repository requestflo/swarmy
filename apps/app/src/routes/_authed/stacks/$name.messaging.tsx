import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { MessagingTab } from '@/components/app-tabs/messaging/messaging-tab';

/** Jobs & queues tab: queues, scheduled jobs and webhooks for this app. */
export const Route = createFileRoute('/_authed/stacks/$name/messaging')({
  component: MessagingTabRoute,
});

function MessagingTabRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <MessagingTab stack={name} />;
}
