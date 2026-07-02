import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WebhookIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/webhooks')({
  component: WebhooksPage,
});

function WebhooksPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Webhooks"
        title={
          <>
            <em>Webhooks</em>.
          </>
        }
        description="Inbound endpoints that receive, verify and route events — plus your outbound delivery feed."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<WebhookIcon />}
          title="No endpoints yet"
          description="Create an inbound endpoint to receive, verify and route events into queues or services."
        />
      </div>
    </div>
  );
}
