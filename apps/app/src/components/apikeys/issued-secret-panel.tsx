import * as React from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, CopyButton } from '@swarmy/ui';

interface SecretLine {
  /** Mono micro-label shown above the value (e.g. "secret", "usage"). */
  label: string;
  /** The value to display and copy. */
  value: string;
}

interface IssuedSecretPanelProps {
  /** Bold headline for the one-time reveal. */
  title: string;
  /** Ordered secret/usage lines — each is a copyable mono code block. */
  lines: SecretLine[];
}

/**
 * Navy statement panel shown once, right after a credential is minted. The
 * plaintext secret is never returned again, so we lean on the ink surface to
 * make the "copy it now" moment loud.
 */
export function IssuedSecretPanel({ title, lines }: IssuedSecretPanelProps): React.JSX.Element {
  return (
    <Alert className="ink-block border-0">
      <KeyRoundIcon className="size-4" />
      <AlertTitle className="font-bold">{title}</AlertTitle>
      <AlertDescription className="text-ink-foreground/70 space-y-4">
        {lines.map((line) => (
          <div key={line.label}>
            <p className="mono-label mt-3 mb-1 first:mt-0">{line.label}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                {line.value}
              </code>
              <CopyButton value={line.value} label="Copy" />
            </div>
          </div>
        ))}
      </AlertDescription>
    </Alert>
  );
}
