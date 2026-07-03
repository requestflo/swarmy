import * as React from 'react';
import { CheckIcon, CopyIcon, KeyRoundIcon, XIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

export interface RevealedSecret {
  family: string;
  version: number;
  /** The value the user just typed/generated — shown here ONCE, never again. */
  value: string;
}

interface SecretRevealBannerProps {
  revealed: RevealedSecret;
  onDismiss: () => void;
}

/**
 * Reveal-once banner: after create, the value is write-only forever — this
 * dismissible coral strip at the top of the list is the last chance to copy it.
 */
export function SecretRevealBanner({
  revealed,
  onDismiss,
}: SecretRevealBannerProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(revealed.value).then(() => {
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
          <span className="mono-data">{revealed.family}</span> is live (v{revealed.version}) — copy
          the value now.
        </p>
        <p className="mono-data text-muted-foreground truncate text-xs select-all">
          {revealed.value}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? 'Copied' : 'Copy value'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground size-8 p-0"
          title="Dismiss — the value can never be shown again"
          onClick={onDismiss}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
