import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import { Button, CopyButton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { bytes } from '@/lib/format';

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Payload detail: captured headers, raw body, replay — inline under the row. */
export function DeliveryDetailInline({ deliveryId }: { deliveryId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const detail = useQuery(trpc.inboundWebhooks.delivery.queryOptions({ id: deliveryId }));

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

  if (detail.isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[0, 1].map((i) => (
          <div key={i} className="shimmer-line h-10 rounded-lg" />
        ))}
      </div>
    );
  }
  if (detail.isError || !d) {
    return <p className="text-muted-foreground p-4 text-sm">Couldn&apos;t load — {detail.error?.message}</p>;
  }

  return (
    <div className="space-y-4 p-4">
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
        <span className="mono-data text-muted-foreground text-xs">
          {d.attempts} attempt{d.attempts === 1 ? '' : 's'} · {bytes(d.bodyBytes)}
        </span>
      </div>

      <section>
        <h4 className="mono-label text-muted-foreground mb-2">Headers</h4>
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
        <h4 className="mono-label text-muted-foreground mb-2">Payload</h4>
        <pre className="card-pop mono-data max-h-96 overflow-auto whitespace-pre-wrap break-all p-4 text-xs">
          {prettyBody(d.body) || '(empty body)'}
        </pre>
      </section>
    </div>
  );
}
