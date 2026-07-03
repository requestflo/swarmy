import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import type { InboundDeliveryStatusView, InboundDeliveryView } from '@swarmy/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, StatusBadge, type StatusTone, cn } from '@swarmy/ui';
import { bytes, relTime } from '@/lib/format';
import { DeliveryDetailInline } from './delivery-detail-inline';

export const DELIVERY_TONE: Record<InboundDeliveryStatusView, { tone: StatusTone; label: string }> = {
  pending: { tone: 'progress', label: 'pending' },
  delivered: { tone: 'online', label: 'delivered' },
  failed: { tone: 'warning', label: 'failed' },
  dead: { tone: 'offline', label: 'dead' },
};

/** One feed row: time, endpoint, verify + status badges — row-expands to the inspector. */
export function DeliveryRow({ delivery: d }: { delivery: InboundDeliveryView }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const tone = DELIVERY_TONE[d.status];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-accent/40 flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left"
          aria-label={`${open ? 'Collapse' : 'Expand'} delivery from ${d.endpointName}`}
        >
          <ChevronDownIcon
            className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
          <span className="mono-data text-muted-foreground w-16 shrink-0 text-xs">{relTime(d.receivedAt)}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.endpointName}</span>
          <StatusBadge
            tone={d.verifyOk ? 'online' : 'offline'}
            label={d.verifyOk ? 'verified' : 'rejected'}
            className="hidden sm:inline-flex"
          />
          <StatusBadge tone={tone.tone} label={tone.label} />
          <span className="mono-data text-muted-foreground hidden w-24 text-right text-xs md:inline">
            {d.attempts > 0 ? `${d.attempts} attempt${d.attempts === 1 ? '' : 's'}` : '—'}
          </span>
          <span className="mono-data text-muted-foreground hidden w-16 text-right text-xs lg:inline">
            {bytes(d.bodyBytes)}
          </span>
          {d.lastError ? (
            <span className="text-status-warning w-full truncate text-xs sm:w-auto sm:max-w-64" title={d.lastError}>
              {d.lastError}
            </span>
          ) : null}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border bg-muted/10 border-t">
          <DeliveryDetailInline deliveryId={d.id} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
