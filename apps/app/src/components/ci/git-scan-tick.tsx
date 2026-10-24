import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

/** The found list's checkbox: coral when ticked, muted when required or held by the Heroku import. */
export function GitScanTick({
  on,
  label,
  locked,
  onToggle,
}: {
  on: boolean;
  label: string;
  /** Required, or the Heroku import decides: shown, not toggleable. */
  locked?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-disabled={locked || undefined}
      aria-label={label}
      onClick={locked ? undefined : onToggle}
      className={cn(
        'mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md border-[1.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7',
        locked ? 'border-muted bg-muted text-muted-foreground cursor-default' : on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
      )}
    >
      {on ? <CheckIcon aria-hidden className="size-3" strokeWidth={3.2} /> : null}
    </button>
  );
}
