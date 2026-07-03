import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, WebhookIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CreateEndpointInline } from './create-endpoint-inline';
import { DeliveriesFeed } from './deliveries-feed';
import { EndpointsTable } from './endpoints-table';
import { OutboundSection } from './outbound-section';

/**
 * Webhooks section of the stack Messaging tab: this stack's inbound gateway
 * endpoints (public URL + custom domain side by side), the live deliveries
 * feed, and the (org-wide) outbound delivery gateway underneath.
 */
export function StackWebhooksSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);

  const overview = useQuery({
    ...trpc.inboundWebhooks.overview.queryOptions({ stack }),
    refetchInterval: 10_000,
  });
  const endpoints = useQuery({
    ...trpc.inboundWebhooks.listEndpoints.queryOptions({ stack }),
    refetchInterval: 10_000,
  });

  const o = overview.data;
  const rows = endpoints.data ?? [];
  const subtitle =
    !o || o.endpoints === 0
      ? 'public URLs for third-party events'
      : o.dead > 0
        ? `${o.dead} dead letter${o.dead === 1 ? '' : 's'} need you`
        : `${o.deliveries24h.toLocaleString()} events in 24h`;

  return (
    <div className="space-y-6">
      <Card className="card-pop border-0">
        <CardContent className="space-y-4 p-6">
          <Collapsible open={creating} onOpenChange={setCreating}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                <WebhookIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold leading-tight">Inbound webhooks</h3>
                <p className="text-muted-foreground mono-label !mb-0">{subtitle}</p>
              </div>
              <CollapsibleTrigger asChild>
                <Button variant="outline" className="shrink-0">
                  <PlusIcon className="size-4" /> New endpoint
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
                <CreateEndpointInline stack={stack} onDone={() => setCreating(false)} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {endpoints.isLoading ? (
            <div className="space-y-2">
              <div className="shimmer-line h-12 rounded-lg" />
              <div className="shimmer-line h-12 rounded-lg" />
            </div>
          ) : endpoints.isError ? (
            <div className="flex flex-wrap items-center gap-3 py-2">
              <p className="text-status-offline text-sm">{endpoints.error.message}</p>
              <Button variant="outline" size="sm" onClick={() => void endpoints.refetch()}>
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<WebhookIcon />}
              title={`No endpoints in ${stack} yet.`}
              description="Give a third party a public URL. swarmy verifies each payload (HMAC, GitHub or Stripe signatures), stores it, and pushes it into a queue or forwards it — with retries and a dead-letter feed."
              action={
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <PlusIcon className="size-4" /> New endpoint
                </Button>
              }
            />
          ) : (
            <EndpointsTable stack={stack} endpoints={rows} />
          )}

          {rows.length > 0 ? <DeliveriesFeed stack={stack} endpoints={rows} /> : null}
        </CardContent>
      </Card>

      <OutboundSection />
    </div>
  );
}
