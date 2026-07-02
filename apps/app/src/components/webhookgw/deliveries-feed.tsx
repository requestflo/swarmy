import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { InboxIcon } from 'lucide-react';
import {
  INBOUND_DELIVERY_STATUSES,
  type InboundDeliveryStatusView,
  type InboundEndpointView,
} from '@swarmy/core';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DeliveryRow } from './delivery-row';

type StatusFilter = InboundDeliveryStatusView | 'all';

/** The live deliveries feed: status chips (incl. dead letters), endpoint filter. */
export function DeliveriesFeed({
  endpoints,
  onInspect,
}: {
  endpoints: InboundEndpointView[];
  onInspect: (id: string) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const [status, setStatus] = React.useState<StatusFilter>('all');
  const [endpointId, setEndpointId] = React.useState<string>('all');

  const feed = useQuery({
    ...trpc.inboundWebhooks.deliveries.queryOptions({
      ...(status !== 'all' ? { status } : {}),
      ...(endpointId !== 'all' ? { endpointId } : {}),
      limit: 50,
    }),
    refetchInterval: 5_000,
  });

  const rows = feed.data?.deliveries ?? [];

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mono-label text-muted-foreground mr-auto">Deliveries</h2>
        {(['all', ...INBOUND_DELIVERY_STATUSES] as StatusFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              'mono-label rounded-full border px-3 py-1 !text-[10px] transition-colors',
              status === s
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {s === 'dead' ? 'dead letters' : s}
          </button>
        ))}
        <Select value={endpointId} onValueChange={setEndpointId}>
          <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All endpoints</SelectItem>
            {endpoints.map((e) => (
              <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {feed.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : feed.isError ? (
        <div className="card-pop text-muted-foreground flex items-center justify-between gap-3 p-5 text-sm">
          <span>Couldn't load deliveries — {feed.error.message}</span>
          <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop text-muted-foreground flex items-center gap-3 p-6 text-sm">
          <InboxIcon className="size-4 shrink-0" />
          {status === 'all'
            ? 'Quiet so far — send a test event to any endpoint URL and it lands here.'
            : `No ${status === 'dead' ? 'dead-letter' : status} deliveries right now.`}
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {rows.map((d) => (
            <DeliveryRow key={d.id} delivery={d} onInspect={onInspect} />
          ))}
        </div>
      )}
    </section>
  );
}
