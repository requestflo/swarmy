import { createFileRoute } from '@tanstack/react-router';
import { WebhooksPage } from '@/components/webhookgw/webhooks-page';

export const Route = createFileRoute('/_authed/webhooks')({
  component: WebhooksPage,
});
