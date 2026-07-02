import { createFileRoute } from '@tanstack/react-router';
import { QueuesPage } from '@/components/queues/queues-page';

export const Route = createFileRoute('/_authed/queues')({
  component: QueuesPage,
});
