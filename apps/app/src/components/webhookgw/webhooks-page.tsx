import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CreateEndpointDialog } from './create-endpoint-dialog';
import { InboundTab } from './inbound-tab';
import { OutboundTab } from './outbound-tab';

/**
 * Operations → Webhooks: the inbound gateway (public endpoints that receive,
 * verify and route third-party events into queues or services) plus the
 * outbound delivery feed (swarmy events pushed to your own URLs).
 */
export function WebhooksPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.inboundWebhooks.overview.queryOptions(),
    refetchInterval: 10_000,
  });

  const o = overview.data;
  const title =
    !o || o.endpoints === 0 ? (
      <>
        Events, <em>in</em>.
      </>
    ) : o.dead > 0 ? (
      <>
        {o.dead.toLocaleString()} dead letters need <em>you</em>.
      </>
    ) : (
      <>
        {o.deliveries24h.toLocaleString()} events in <em>24h</em>.
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Webhooks"
        title={title}
        description="Give Stripe, GitHub or any service a URL — swarmy verifies each payload, keeps the history, and routes it into a queue or forwards it on, with retries."
        actions={<CreateEndpointDialog />}
      />

      <Tabs defaultValue="inbound">
        <TabsList className="mb-4">
          <TabsTrigger value="inbound">
            Inbound
            {o && o.pending > 0 ? (
              <span className="mono-data bg-status-progress/12 text-status-progress ml-1.5 rounded-full px-1.5 text-[10px]">
                {o.pending}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="outbound">Outbound</TabsTrigger>
        </TabsList>
        <TabsContent value="inbound">
          <InboundTab />
        </TabsContent>
        <TabsContent value="outbound">
          <OutboundTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
