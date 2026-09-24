import * as React from 'react';
import { Alert, AlertDescription, AlertTitle, CopyButton } from '@swarmy/ui';

interface BackupCodesPanelProps {
  codes: string[];
}

/** One-time display of backup codes. Each works once; they are never shown again. */
export function BackupCodesPanel({ codes }: BackupCodesPanelProps): React.JSX.Element {
  const text = codes.join('\n');
  return (
    <div className="space-y-3">
      <Alert>
        <AlertTitle>Save these backup codes now</AlertTitle>
        <AlertDescription>
          Each code signs you in once if you lose your authenticator. swarmy will not show them again.
        </AlertDescription>
      </Alert>
      <ul className="bg-muted grid grid-cols-2 gap-x-6 gap-y-1 rounded-md p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex items-center gap-2 text-sm">
        <CopyButton value={text} /> <span className="text-muted-foreground">Copy all {codes.length} codes</span>
      </div>
    </div>
  );
}
