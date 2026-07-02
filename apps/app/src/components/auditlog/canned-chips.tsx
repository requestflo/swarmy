import * as React from 'react';
import { cn } from '@swarmy/ui';
import { CANNED_QUESTIONS } from './canned-questions';

/** One-tap compliance questions — each chip applies a saved prefix filter. */
export function CannedChips({
  active,
  onPick,
}: {
  active: string | null;
  onPick: (key: string | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {CANNED_QUESTIONS.map((q) => {
        const isActive = active === q.key;
        return (
          <button
            key={q.key}
            type="button"
            title={q.hint}
            onClick={() => onPick(isActive ? null : q.key)}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors',
              isActive
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent',
            )}
          >
            {q.label}
          </button>
        );
      })}
    </div>
  );
}
