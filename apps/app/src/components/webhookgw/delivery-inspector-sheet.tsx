import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import {
  Button,
  CopyButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { bytes } from '@/lib/format';
import { DELIVERY_TONE } from './delivery-row';

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Payload inspector drawer: verify/status, captured headers, raw body, replay. */
export function DeliveryInspectorSheet({
  deliveryId,
  onOpenChange,
}: {
  deliveryId: string | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const open = deliveryId !== null;

  const detail = useQuery({
    ...trpc.inboundWebhooks.delivery.queryOptions({ id: deliveryId ?? '' }),
    enabled: open,
  });

  const replay = useMutation(
    trpc.inboundWebhooks.replay.mutationOptions({
      onSuccess: () => {
        toast.success('Queued for redelivery — the dispatcher picks it up within seconds');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const d = detail.data;
  const tone = d ? DELIVERY_TONE[d.status] : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-border border-b p-6">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            Delivery
            {d ? <StatusBadge tone={d.verifyOk ? 'online' : 'offline'} label={d.verifyOk ? 'verified' : 'rejected'} /> : null}
            {tone ? <StatusBadge tone={tone.tone} label={tone.label} /> : null}
          </SheetTitle>
          <SheetDescription className="mono-data !mb-0 text-xs">
            {d
              ? `${d.endpointName} · ${new Date(d.receivedAt).toLocaleString()} · ${d.attempts} attempt${d.attempts === 1 ? '' : 's'} · ${bytes(d.bodyBytes)}`
              : '…'}
          </SheetDescription>
        </SheetHeader>

        {detail.isLoading ? (
          <div className="space-y-3 p-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="shimmer-line h-10 rounded-lg" />
            ))}
          </div>
        ) : detail.isError ? (
          <p className="text-muted-foreground p-6 text-sm">Couldn't load — {detail.error.message}</p>
        ) : !d ? null : (
          <div className="space-y-6 p-6">
            {d.lastError ? (
              <p className="text-status-warning bg-status-warning/10 rounded-lg p-3 text-xs">
                Last error: {d.lastError}
                {d.nextAttemptAt ? ` — retrying ${new Date(d.nextAttemptAt).toLocaleTimeString()}` : ''}
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!d.verifyOk || d.status === 'pending' || replay.isPending}
                onClick={() => replay.mutate({ id: d.id })}
              >
                <RotateCcwIcon className="size-4" />
                {replay.isPending ? 'Replaying…' : 'Replay delivery'}
              </Button>
              <CopyButton value={d.body} label="Copy payload" />
            </div>

            <section>
              <h3 className="mono-label text-muted-foreground mb-2">Headers</h3>
              <div className="card-pop divide-border max-h-48 divide-y overflow-y-auto text-xs">
                {Object.entries(d.headers).map(([k, v]) => (
                  <div key={k} className="flex gap-2 px-3 py-1.5">
                    <span className="mono-data text-muted-foreground w-44 shrink-0 truncate">{k}</span>
                    <span className="mono-data min-w-0 break-all">{v}</span>
                  </div>
                ))}
                {Object.keys(d.headers).length === 0 ? (
                  <p className="text-muted-foreground px-3 py-2">No headers captured.</p>
                ) : null}
              </div>
            </section>

            <section>
              <h3 className="mono-label text-muted-foreground mb-2">Payload</h3>
              <pre className="card-pop mono-data max-h-96 overflow-auto whitespace-pre-wrap break-all p-4 text-xs">
                {prettyBody(d.body) || '(empty body)'}
              </pre>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
