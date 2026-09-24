import * as React from 'react';
import { AlertTriangleIcon, InfoIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { EmailOverviewData } from './use-email';

/** Plain-words notices: port 25 blocked, fresh-IP reputation, no durable log. */
export function EmailWarnings({ warnings }: { warnings: EmailOverviewData['warnings'] }): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      {warnings.map((w) => (
        <div
          key={w.id}
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 text-sm',
            w.level === 'warn' ? 'border-status-warning/40 bg-status-warning/8' : 'border-border bg-card',
          )}
        >
          {w.level === 'warn' ? (
            <AlertTriangleIcon className="text-status-warning mt-0.5 size-4 shrink-0" />
          ) : (
            <InfoIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          )}
          <p className={w.level === 'warn' ? 'font-medium' : 'text-muted-foreground'}>{w.message}</p>
        </div>
      ))}
    </div>
  );
}
