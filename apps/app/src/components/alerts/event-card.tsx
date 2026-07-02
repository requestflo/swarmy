import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import type { AlertEventView } from '@swarmy/core';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { SEVERITY_TONE } from './alert-tones';

/** One alert event — a flat row with severity, resource, message and ack. */
export function EventCard({ event }: { event: AlertEventView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ack = useMutation(
    trpc.alerts.ack.mutationOptions({
      onSuccess: () => {
        toast.success('Acknowledged — event resolved.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const firing = event.status === 'firing';
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
      <StatusBadge
        tone={firing ? SEVERITY_TONE[event.severity] : 'online'}
        label={firing ? event.severity : 'resolved'}
        className="w-20 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="mono-data text-sm font-semibold">{event.signal}</span>
          <span className="mono-data text-muted-foreground truncate text-xs">{event.resource}</span>
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-sm">{event.message}</p>
      </div>
      <span className="mono-data text-muted-foreground shrink-0 text-xs">
        {firing
          ? `fired ${relTime(event.firedAt)}`
          : `resolved ${relTime(event.resolvedAt ?? event.firedAt)}`}
      </span>
      {firing ? (
        <Button
          size="sm"
          variant="outline"
          disabled={ack.isPending}
          onClick={() => ack.mutate({ id: event.id })}
        >
          <CheckIcon className="size-3.5" /> {ack.isPending ? 'Acking…' : 'Ack'}
        </Button>
      ) : null}
    </div>
  );
}
