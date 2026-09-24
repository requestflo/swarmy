import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import type { CodeKind } from './two-factor-api';

interface CodeEntryFormProps {
  onSubmit: (code: string, kind: CodeKind) => Promise<void>;
  submitLabel?: string;
  /** Hide the backup-code switch (e.g. confirming a brand-new authenticator). */
  totpOnly?: boolean;
  autoFocus?: boolean;
}

/** A 6-digit authenticator code (or a backup code) with inline error. */
export function CodeEntryForm({
  onSubmit,
  submitLabel = 'Verify',
  totpOnly = false,
  autoFocus = true,
}: CodeEntryFormProps): React.JSX.Element {
  const [kind, setKind] = React.useState<CodeKind>('totp');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(code, kind);
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not work.');
    } finally {
      setBusy(false);
    }
  }

  const isTotp = kind === 'totp';
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="mfa-code">{isTotp ? 'Authenticator code' : 'Backup code'}</Label>
        <Input
          id="mfa-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="one-time-code"
          inputMode={isTotp ? 'numeric' : 'text'}
          placeholder={isTotp ? '123456' : 'aB3xk-9Qm2z'}
          maxLength={isTotp ? 8 : 16}
          className="font-mono tracking-widest"
        />
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={busy || code.trim().length < (isTotp ? 6 : 8)}>
        {busy ? 'Checking…' : submitLabel}
      </Button>
      {!totpOnly && (
        <button
          type="button"
          className="text-muted-foreground w-full text-center text-sm hover:underline"
          onClick={() => {
            setKind(isTotp ? 'backup' : 'totp');
            setCode('');
            setError(null);
          }}
        >
          {isTotp ? 'Use a backup code instead' : 'Use your authenticator app'}
        </button>
      )}
    </form>
  );
}
