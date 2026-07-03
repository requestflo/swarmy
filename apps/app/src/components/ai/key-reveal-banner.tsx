import * as React from 'react';
import { KeyRoundIcon, XIcon } from 'lucide-react';
import { Button, CopyButton } from '@swarmy/ui';

interface KeyRevealBannerProps {
  title?: string;
  keyValue: string;
  gatewayUrl: string;
  onDismiss: () => void;
}

/**
 * REVEAL-ONCE banner: a coral-accented, dismissible inline strip shown at the
 * top of the relevant list right after a virtual key is minted — never a
 * modal. Once dismissed the key exists only as a hash.
 */
export function KeyRevealBanner({
  title = "Save this key now — it's shown once.",
  keyValue,
  gatewayUrl,
  onDismiss,
}: KeyRevealBannerProps): React.JSX.Element {
  return (
    <div className="border-primary/40 bg-primary/5 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
          <KeyRoundIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-muted-foreground text-xs">
            swarmy keeps only a hash. Point your app at the gateway URL and send the key as the{' '}
            <code className="mono-data">x-swarmy-ai-key</code> header.
          </p>
          <div className="bg-card flex items-center justify-between gap-2 rounded-md border px-3 py-2">
            <code className="mono-data truncate text-xs">{keyValue}</code>
            <CopyButton value={keyValue} />
          </div>
          <div className="bg-card flex items-center justify-between gap-2 rounded-md border px-3 py-2">
            <code className="mono-data truncate text-xs">{gatewayUrl}</code>
            <CopyButton value={gatewayUrl} />
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
