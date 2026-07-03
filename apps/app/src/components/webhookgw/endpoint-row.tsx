import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, ChevronDownIcon, GlobeIcon, ListOrderedIcon } from 'lucide-react';
import type { InboundEndpointView } from '@swarmy/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { EndpointEditInline } from './endpoint-edit-inline';

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

/**
 * One inbound endpoint as a flat row — public URL and custom domain shown
 * side by side (this is where the gateway meets DNS). Row-expand reveals the
 * edit form (target/verify/templates); delete is an `AlertDialog` confirm.
 */
export function EndpointRow({
  stack,
  endpoint: e,
}: {
  stack: string;
  endpoint: InboundEndpointView;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const remove = useMutation(
    trpc.inboundWebhooks.removeEndpoint.mutationOptions({
      onSuccess: () => {
        toast.success('Endpoint removed');
        void qc.invalidateQueries();
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="hover:bg-accent/40 flex flex-wrap items-center gap-3 px-3 py-3">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-left"
            aria-label={`${open ? 'Collapse' : 'Expand'} endpoint ${e.name}`}
          >
            <ChevronDownIcon
              className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')}
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold">{e.name}</span>
                <span className="mono-label bg-muted text-muted-foreground rounded-full px-2 py-0.5 !text-[10px]">
                  {VERIFY_LABEL[e.verifyKind]}
                </span>
              </span>
              <span className="mono-data text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 truncate text-xs">
                <span title={e.url}>{e.url}</span>
                {e.domain ? (
                  <span className="text-primary inline-flex items-center gap-1" title={e.domain}>
                    <GlobeIcon className="size-3" /> {e.domain}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        <div className="text-muted-foreground hidden text-xs sm:block">{targetSummary(e)}</div>
        <div className="mono-data hidden text-right text-xs lg:block">
          <span className="text-foreground font-semibold">{e.deliveries24h}</span>
          <span className="text-muted-foreground"> / 24h</span>
          <p className="text-muted-foreground">{e.lastDeliveryAt ? relTime(e.lastDeliveryAt) : 'no deliveries yet'}</p>
        </div>
        <div className="flex items-center gap-1">
          <CopyButton value={e.url} label="Copy URL" />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-status-offline">
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {e.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The URL stops working immediately and its delivery history is deleted. This
                  can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate({ id: e.id })}>
                  {remove.isPending ? 'Removing…' : 'Remove endpoint'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <CollapsibleContent>
        <div className="border-border bg-muted/10 mx-3 mb-3 rounded-lg border p-4">
          <EndpointEditInline stack={stack} endpoint={e} onDone={() => setOpen(false)} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
