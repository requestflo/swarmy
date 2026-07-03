import * as React from 'react';
import { cn } from '@swarmy/ui';

export interface ConsumerChip {
  serviceId: string;
  serviceName: string;
  upToDate: boolean;
}

/** Attached-services chips (first few + overflow count) — stale ones glow amber. */
export function ConsumerChips({ consumers }: { consumers: ConsumerChip[] }): React.JSX.Element {
  const shown = consumers.slice(0, 3);
  const extra = consumers.length - shown.length;
  if (consumers.length === 0) {
    return <span className="text-muted-foreground text-xs">not attached yet</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((c) => (
        <span
          key={c.serviceId}
          className={cn(
            'mono-data rounded-full border px-2 py-0.5 text-[11px]',
            c.upToDate
              ? 'border-border text-muted-foreground'
              : 'border-status-warning/40 text-status-warning',
          )}
        >
          {c.serviceName}
        </span>
      ))}
      {extra > 0 ? (
        <span className="mono-data text-muted-foreground text-[11px]">+{extra}</span>
      ) : null}
    </span>
  );
}
