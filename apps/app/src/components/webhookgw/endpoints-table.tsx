import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, ListOrderedIcon, Trash2Icon } from 'lucide-react';
import type { InboundEndpointView } from '@swarmy/core';
import { Button, CopyButton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

const VERIFY_LABEL: Record<InboundEndpointView['verifyKind'], string> = {
  none: 'no verify',
  hmac: 'HMAC',
  github: 'GitHub',
  stripe: 'Stripe',
};

function targetSummary(e: InboundEndpointView): React.JSX.Element {
  if (e.target.kind === 'queue') {
    return (
      <span className="inline-flex items-center gap-1">
        <ListOrderedIcon className="size-3.5" />
        {e.target.cacheCluster} / {e.target.queue}
        <span className="text-muted-foreground">({e.target.convention})</span>
      </span>
    );
  }
  let host = e.target.url;
  try {
    host = new URL(e.target.url).host;
  } catch {
    // keep the raw URL
  }
  return (
    <span className="inline-flex items-center gap-1">
      <ArrowRightIcon className="size-3.5" />
      {host}
    </span>
  );
}

/** Flat endpoint rows in one card: name, public URL copy, verify, target, volume. */
export function EndpointsTable({
  endpoints,
}: {
  endpoints: InboundEndpointView[];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const remove = useMutation(
    trpc.inboundWebhooks.removeEndpoint.mutationOptions({
      onSuccess: () => {
        toast.success('Endpoint removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="card-pop divide-border divide-y overflow-hidden">
      {endpoints.map((e) => (
        <div key={e.id} className="hover:bg-accent/40 flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold">{e.name}</span>
              <span className="mono-label bg-muted text-muted-foreground rounded-full px-2 py-0.5 !text-[10px]">
                {VERIFY_LABEL[e.verifyKind]}
              </span>
            </div>
            <p className="mono-data text-muted-foreground mt-0.5 truncate text-xs" title={e.url}>
              {e.url}
            </p>
          </div>
          <div className="text-muted-foreground hidden text-xs sm:block">{targetSummary(e)}</div>
          <div className="mono-data hidden text-right text-xs lg:block">
            <span className="text-foreground font-semibold">{e.deliveries24h}</span>
            <span className="text-muted-foreground"> / 24h</span>
            <p className="text-muted-foreground">{e.lastDeliveryAt ? relTime(e.lastDeliveryAt) : 'no deliveries yet'}</p>
          </div>
          <div className="flex items-center gap-1">
            <CopyButton value={e.url} label="Copy URL" />
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-status-offline"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove "${e.name}" and its delivery history? The URL stops working immediately.`)) {
                  remove.mutate({ id: e.id });
                }
              }}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
