import * as React from 'react';
import { KeyRoundIcon, XIcon } from 'lucide-react';
import { Button, CopyButton } from '@swarmy/ui';

/**
 * Reveal-once secret banner — coral-accented, dismissible, shown inline where
 * the item that just gained a secret lives. Never a modal.
 */
export function SecretRevealBanner({
  title,
  description,
  secret,
  onDismiss,
}: {
  title: string;
  description: React.ReactNode;
  secret: string;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="border-primary/40 bg-primary/5 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRoundIcon className="text-primary size-4 shrink-0" />
          <p className="truncate text-sm font-medium">{title}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mt-1.5 -mr-1.5 size-7 shrink-0"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="mt-2">
        <div className="bg-background flex items-center justify-between gap-2 rounded-md px-3 py-2">
          <code className="mono-data truncate text-xs">{secret}</code>
          <CopyButton value={secret} />
        </div>
      </div>
      <p className="text-muted-foreground mono-label mt-2 !mb-0">{description}</p>
    </div>
  );
}
