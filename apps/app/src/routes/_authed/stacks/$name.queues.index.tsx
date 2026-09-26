import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { QueuesTab } from '@/components/queues/queues-tab';

/** Data › Queues: every BullMQ queue this app uses; one store opens in the queue studio. */
export const Route = createFileRoute('/_authed/stacks/$name/queues/')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <QueuesTab stack={name} />;
}
