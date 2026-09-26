import * as React from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { CopyButton } from '@swarmy/ui';

/**
 * One-time reveals from a deploy (a generated admin password, first-login
 * steps). Shown once, inline, never in a modal — and never retrievable again.
 */
export function DeploySecretsBanner({ notes }: { notes: string[] }): React.JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <section aria-label="Save these now" className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-xl border px-4 py-3">
      <p className="mono-label text-primary flex items-center gap-1.5">
        <KeyRoundIcon aria-hidden className="size-3.5" /> Save these now — shown once
      </p>
      {notes.map((note) => (
        <div key={note} className="flex items-center justify-between gap-2">
          <code className="mono-data min-w-0 text-xs break-all">{note}</code>
          <CopyButton value={note} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11" />
        </div>
      ))}
    </section>
  );
}
