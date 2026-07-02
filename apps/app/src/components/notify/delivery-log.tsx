import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { MailIcon } from 'lucide-react';
import type { NotifyDeliveryStatusView, NotifyDeliveryView } from '@swarmy/core';
import { NOTIFY_DELIVERY_STATUSES } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type StatusFilter = NotifyDeliveryStatusView | 'all';

const STATUS_TONE: Record<NotifyDeliveryStatusView, string> = {
  queued: 'bg-status-progress/12 text-status-progress',
  sent: 'bg-status-online/12 text-status-online',
  failed: 'bg-status-offline/12 text-status-offline',
  bounced: 'bg-status-warning/12 text-status-warning',
};

function when(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** The delivery log: to, subject, status chip (incl. bounced), when, error. */
export function DeliveryLog(): React.JSX.Element {
  const trpc = useTRPC();
  const [status, setStatus] = React.useState<StatusFilter>('all');

  const log = useQuery({
    ...trpc.notifications.deliveries.queryOptions({
      ...(status !== 'all' ? { status } : {}),
      limit: 50,
    }),
    refetchInterval: 5_000,
  });
  const rows = log.data?.deliveries ?? [];

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mono-label text-muted-foreground mr-auto">Delivery log</h2>
        {(['all', ...NOTIFY_DELIVERY_STATUSES] as StatusFilter[]).map((s) => (
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
            {s}
          </button>
        ))}
      </div>

      {log.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : log.isError ? (
        <div className="card-pop text-muted-foreground flex items-center justify-between gap-3 p-5 text-sm">
          <span>Couldn't load the delivery log — {log.error.message}</span>
          <Button variant="outline" size="sm" onClick={() => void log.refetch()}>
            Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop text-muted-foreground flex items-center gap-3 p-6 text-sm">
          <MailIcon className="size-4 shrink-0" />
          {status === 'all'
            ? 'Nothing sent yet — save a provider and send yourself a test email.'
            : `No ${status} deliveries right now.`}
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {rows.map((d) => (
            <DeliveryRow key={d.id} d={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeliveryRow({ d }: { d: NotifyDeliveryView }): React.JSX.Element {
  return (
    <div className="hover:bg-accent/50 flex items-center gap-3 px-4 py-3">
      <span
        className={cn(
          'mono-label shrink-0 rounded-full px-2.5 py-0.5 !text-[10px]',
          STATUS_TONE[d.status],
        )}
      >
        {d.status}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{d.subject ?? '(no subject)'}</div>
        <div className="text-muted-foreground truncate text-xs">
          to {d.to}
          {d.template ? ` · template ${d.template}` : ''}
          {d.attempts > 1 ? ` · attempt ${d.attempts}` : ''}
          {d.error ? ` · ${d.error}` : ''}
        </div>
      </div>
      <span className="mono-data text-muted-foreground shrink-0 text-xs">{when(d.createdAt)}</span>
    </div>
  );
}
