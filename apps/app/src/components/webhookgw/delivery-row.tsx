import * as React from 'react';
import type { InboundDeliveryStatusView, InboundDeliveryView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';
import { bytes, relTime } from '@/lib/format';

export const DELIVERY_TONE: Record<InboundDeliveryStatusView, { tone: StatusTone; label: string }> = {
  pending: { tone: 'progress', label: 'pending' },
  delivered: { tone: 'online', label: 'delivered' },
  failed: { tone: 'warning', label: 'failed' },
  dead: { tone: 'offline', label: 'dead' },
};

/** One feed row: time, endpoint, verify + status badges, attempts, size, error. */
export function DeliveryRow({
  delivery: d,
  onInspect,
}: {
  delivery: InboundDeliveryView;
  onInspect: (id: string) => void;
}): React.JSX.Element {
  const tone = DELIVERY_TONE[d.status];
  return (
    <button
      type="button"
      onClick={() => onInspect(d.id)}
      className="hover:bg-accent/40 flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left"
    >
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
  );
}
