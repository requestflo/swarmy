import * as React from 'react';
import { KeyRoundIcon, XIcon } from 'lucide-react';
import { Button, CopyButton } from '@swarmy/ui';

interface SecretRevealBannerProps {
  /** "Cache main is provisioning." */
  title: string;
  /** Where the secret lives from now on (Docker secret name etc). */
  description: React.ReactNode;
  /** The reveal-once secret value. */
  secret: string;
  /** Optional second copyable line (endpoint / URL). */
  endpoint?: string;
  onDismiss: () => void;
}

/**
 * Reveal-once secret banner — coral-accented, dismissible, shown inline at the
 * top of the list that just gained the item. Never a modal: the secret stays
 * on screen until the user dismisses it, so nothing blocks the workspace.
 */
export function SecretRevealBanner({
  title,
  description,
  secret,
  endpoint,
  onDismiss,
}: SecretRevealBannerProps): React.JSX.Element {
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
      <div className="mt-2 space-y-2">
        <div className="bg-background flex items-center justify-between gap-2 rounded-md px-3 py-2">
          <code className="mono-data truncate text-xs">{secret}</code>
          <CopyButton value={secret} />
        </div>
        {endpoint ? (
          <div className="bg-background flex items-center justify-between gap-2 rounded-md px-3 py-2">
            <code className="mono-data truncate text-xs">{endpoint}</code>
            <CopyButton value={endpoint} />
          </div>
        ) : null}
      </div>
      <p className="text-muted-foreground mono-label mt-2 !mb-0">{description}</p>
    </div>
  );
}
