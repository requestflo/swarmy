import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { WebhookIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CreateEndpointDialog } from './create-endpoint-dialog';
import { DeliveriesFeed } from './deliveries-feed';
import { DeliveryInspectorSheet } from './delivery-inspector-sheet';
import { EndpointsTable } from './endpoints-table';

/**
 * Inbound tab: the org's public endpoints (URL to paste into the provider,
 * verify kind, target) and the live deliveries feed with the payload inspector.
 */
export function InboundTab(): React.JSX.Element {
  const trpc = useTRPC();
  const [inspectId, setInspectId] = React.useState<string | null>(null);

  const endpoints = useQuery({
    ...trpc.inboundWebhooks.listEndpoints.queryOptions(),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      {endpoints.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-12 rounded-lg" />
          ))}
        </div>
      ) : endpoints.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<WebhookIcon />}
            title="Couldn't load endpoints"
            description={endpoints.error.message}
            action={
              <Button variant="outline" onClick={() => void endpoints.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : (endpoints.data ?? []).length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<WebhookIcon />}
            title="No endpoints yet — create one."
            description="An endpoint gives a third party a public URL. swarmy verifies each payload (HMAC, GitHub or Stripe signatures), stores it, and pushes it into a queue or forwards it — with retries and a dead-letter feed."
            action={<CreateEndpointDialog variant="outline" />}
          />
        </div>
      ) : (
        <EndpointsTable endpoints={endpoints.data ?? []} />
      )}

      {(endpoints.data ?? []).length > 0 ? (
        <DeliveriesFeed endpoints={endpoints.data ?? []} onInspect={setInspectId} />
      ) : null}

      <DeliveryInspectorSheet
        deliveryId={inspectId}
        onOpenChange={(open) => {
          if (!open) setInspectId(null);
        }}
      />
    </div>
  );
}
