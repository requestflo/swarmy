import * as React from 'react';
import { CheckIcon, CopyIcon, KeyRoundIcon, XIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

export interface RevealedKey {
  accessKeyId: string;
  /** The secret access key — shown here ONCE, never again. */
  secretAccessKey: string;
}

interface KeyRevealBannerProps {
  revealed: RevealedKey;
  onDismiss: () => void;
}

/**
 * Reveal-once banner: the secret access key is never retrievable again — this
 * dismissible coral strip at the top of the keys list is the last chance to copy it.
 */
export function KeyRevealBanner({ revealed, onDismiss }: KeyRevealBannerProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(revealed.secretAccessKey).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    });
  };

  return (
    <div className="border-primary/40 bg-primary/10 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3">
      <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
        <KeyRoundIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">
          <span className="mono-data">{revealed.accessKeyId}</span> is live — copy the secret now.
        </p>
        <p className="mono-data text-muted-foreground truncate text-xs select-all">
          {revealed.secretAccessKey}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? 'Copied' : 'Copy secret'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground size-8 p-0"
          title="Dismiss — the secret can never be shown again"
          onClick={onDismiss}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
