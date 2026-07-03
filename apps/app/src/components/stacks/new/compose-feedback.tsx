import * as React from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { ComposeCheck } from './use-compose-check';

interface ComposeFeedbackProps {
  check: ComposeCheck;
}

/** Live validation readout under the compose textarea: services found + warnings. */
export function ComposeFeedback({ check }: ComposeFeedbackProps): React.JSX.Element | null {
  if (check.status === 'idle') return null;
  if (check.status === 'checking') return <div className="shimmer-line h-10 rounded-xl" />;
  if (check.status === 'error') {
    return (
      <div className="border-status-offline/30 bg-status-offline/5 flex items-start gap-2 rounded-xl border px-3 py-2.5">
        <XCircleIcon className="text-status-offline mt-0.5 size-4 shrink-0" />
        <p className="text-status-offline text-sm break-words">
          {check.parseError ?? "Couldn't parse the compose file."}
        </p>
      </div>
    );
  }
  return (
    <div className="border-border grid gap-2 rounded-xl border px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <CheckCircle2Icon className="text-status-online size-4" />
        {check.services.length} service{check.services.length === 1 ? '' : 's'} ready to deploy
      </p>
      <div className="flex flex-wrap gap-1.5">
        {check.services.map((s) => (
          <span key={s} className="mono-label bg-muted rounded-full px-2 py-0.5 text-[10px]">
            {s}
          </span>
        ))}
      </div>
      {check.warnings.length > 0 && (
        <ul className="grid gap-1">
          {check.warnings.map((w, i) => (
            <li
              key={`${w.path}-${i}`}
              className={cn(
                'flex items-start gap-2 text-xs',
                w.level === 'warn' ? 'text-status-warning' : 'text-muted-foreground',
              )}
            >
              {w.level === 'warn' ? (
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span>
                <span className="font-mono">{w.path}</span> — {w.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
