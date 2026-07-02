import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SendIcon, Trash2Icon } from 'lucide-react';
import { Button, EmptyState, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { RegisterOutboundDialog } from './register-outbound-dialog';

/**
 * Outbound tab: swarmy's own events pushed to YOUR endpoints, over the existing
 * `webhooksOut` router (register, activate, test-ping, remove). Deliveries are
 * signed with the per-endpoint `whsec_…` secret shown once at registration.
 */
export function OutboundTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const endpoints = useQuery({ ...trpc.webhooksOut.list.queryOptions(), refetchInterval: 10_000 });

  const setActive = useMutation(
    trpc.webhooksOut.setActive.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.webhooksOut.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Endpoint removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const test = useMutation(
    trpc.webhooksOut.test.mutationOptions({
      onSuccess: (r) => toast.success(`Ping enqueued to ${r.enqueued} endpoint${r.enqueued === 1 ? '' : 's'}`),
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = endpoints.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          swarmy POSTs org events (deploys, builds, alerts) to these URLs, HMAC-signed.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={rows.length === 0 || test.isPending} onClick={() => test.mutate({ eventType: 'ping' })}>
            <SendIcon className="size-4" /> Send test ping
          </Button>
          <RegisterOutboundDialog />
        </div>
      </div>

      {endpoints.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : endpoints.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SendIcon />}
            title="Couldn't load endpoints"
            description={endpoints.error.message}
            action={<Button variant="outline" onClick={() => void endpoints.refetch()}>Retry</Button>}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SendIcon />}
            title="No outbound endpoints yet"
            description="Register a URL and pick the events to receive — swarmy signs every delivery so your receiver can verify it."
            action={<RegisterOutboundDialog variant="outline" />}
          />
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {rows.map((e) => (
            <div key={e.id} className="hover:bg-accent/40 flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="mono-data truncate text-sm">{e.url}</p>
                <p className="text-muted-foreground text-xs">
                  {e.events.join(', ')} · added {relTime(e.createdAt)}
                </p>
              </div>
              <Switch
                checked={e.active}
                disabled={setActive.isPending}
                onCheckedChange={(active) => setActive.mutate({ id: e.id, active })}
              />
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-status-offline"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Remove ${e.url}? Deliveries stop immediately.`)) remove.mutate({ id: e.id });
                }}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
