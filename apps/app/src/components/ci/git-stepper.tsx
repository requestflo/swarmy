import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

const LABELS = ['Provider', 'Repo', 'Branch & folder', 'Scan'] as const;

/** The git wizard's four steps; the current one is the first not yet done (none once all are). */
export function GitStepper({ done }: { done: readonly [boolean, boolean, boolean, boolean] }): React.JSX.Element {
  const cur = done.indexOf(false);
  return (
    <ol aria-label="Progress" className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {LABELS.map((label, i) => {
        const ticked = done[i] && (cur < 0 || i < cur);
        return (
          <li key={label} className="flex items-center gap-2" aria-current={i === cur ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold',
                ticked ? 'bg-status-online/15 text-tone-ok' : i === cur ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
              )}
            >
              {ticked ? <CheckIcon aria-label="done" className="size-3" /> : i + 1}
            </span>
            <span className={cn('text-[13px]', i === cur ? 'font-semibold' : 'text-muted-foreground')}>{label}</span>
            {i < LABELS.length - 1 ? (
              <span aria-hidden className={cn('h-px w-5 sm:w-9', done[i] ? 'bg-status-online/50' : 'bg-border')} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
