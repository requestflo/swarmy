import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
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
    <>
      <Section
        title="Webhooks in"
        count={endpoints.data ? rows.length : undefined}
        hint={subtitle}
        flush
        action={
          <Depth at="controls">
            <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setCreating((v) => !v)}>
              <PlusIcon className="size-3.5" /> Add an endpoint
            </Button>
          </Depth>
        }
      >
          <Collapsible open={creating} onOpenChange={setCreating}>
            <CollapsibleContent>
              <div className="border-border mb-3 rounded-xl border p-4">
                <CreateEndpointInline stack={stack} onDone={() => setCreating(false)} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {endpoints.isPending ? (
            <RowsSkeleton rows={2} />
          ) : endpoints.isError ? (
            <div className="flex flex-wrap items-center gap-3 py-2">
              <p className="text-tone-bad text-sm">{endpoints.error.message}</p>
              <Button variant="outline" size="sm" onClick={() => void endpoints.refetch()}>
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground py-3 text-[13.5px]">
              No endpoints yet. Give a third party a public URL: swarmy checks each payload's signature, keeps it, and hands
              it to a queue or your service, with retries.
            </p>
          ) : (
            <EndpointsTable stack={stack} endpoints={rows} />
          )}

          {rows.length > 0 ? (
            <Depth at="controls">
              <div className="pb-3">
                <DeliveriesFeed stack={stack} endpoints={rows} />
              </div>
            </Depth>
          ) : null}
      </Section>

      <Depth at="controls">
        <OutboundSection />
      </Depth>
    </>
  );
}
