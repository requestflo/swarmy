import * as React from 'react';
import { CopyButton } from '@swarmy/ui';

interface GitSecretFieldProps {
  label: string;
  value: string;
  /** Long values (a public key) wrap instead of truncating. */
  wrap?: boolean;
}

/** A value shown once, with a copy button. */
export function GitSecretField({
  label,
  value,
  wrap = false,
}: GitSecretFieldProps): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <span className="mono-label">{label}</span>
      <div className="bg-accent/40 flex items-start gap-2 rounded-xl px-3 py-2">
        <code
          className={
            wrap
              ? 'mono-data min-w-0 flex-1 text-xs break-all'
              : 'mono-data min-w-0 flex-1 truncate text-xs'
          }
        >
          {value}
        </code>
        <CopyButton value={value} className="size-7 shrink-0" />
      </div>
    </div>
  );
}
