import * as React from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { TranslationWarning } from '@swarmy/core/compose';

interface ValidationPanelProps {
  warnings: TranslationWarning[];
}

/** Live semantic-validation list shown beside the builder. Never blocks deploy
 * by itself (the deploy gate is name+image); these are advisories. */
export function ValidationPanel({ warnings }: ValidationPanelProps): React.JSX.Element {
  if (warnings.length === 0) {
    return (
      <div className="text-status-success flex items-center gap-2 text-sm">
        <CheckCircle2Icon className="size-4" />
        <span>No issues — ready to deploy.</span>
      </div>
    );
  }
  return (
    <ul className="grid gap-1.5">
      {warnings.map((w, i) => (
        <li
          key={i}
          className={cn(
            'flex items-start gap-2 text-sm',
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
  );
}
