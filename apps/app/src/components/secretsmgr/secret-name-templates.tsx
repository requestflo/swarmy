import * as React from 'react';
import { SECRET_NAME_TEMPLATES } from '@swarmy/core';
import { cn } from '@swarmy/ui';

interface SecretNameTemplatesProps {
  value: string;
  onPick: (family: string) => void;
}

/** Quick-pick chips for common secret NAMES — never values. */
export function SecretNameTemplates({ value, onPick }: SecretNameTemplatesProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SECRET_NAME_TEMPLATES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onPick(t)}
          className={cn(
            'mono-data rounded-full border border-border px-2.5 py-1 text-[11px] transition-colors',
            value === t
              ? 'bg-primary/10 border-primary/40 text-primary font-semibold'
              : 'hover:bg-accent text-muted-foreground',
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
