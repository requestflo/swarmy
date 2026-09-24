import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { QueueStudio } from '@/components/queues/studio/queue-studio';

/** Queue studio: BullMQ queues on one managed cache — counts, jobs, actions, rates. */
export const Route = createFileRoute('/_authed/stacks/$name/queues/$cluster')({
  component: QueueStudioPage,
});

function QueueStudioPage(): React.JSX.Element {
  const { name, cluster } = Route.useParams();
  return <QueueStudio stack={name} cluster={cluster} />;
}
