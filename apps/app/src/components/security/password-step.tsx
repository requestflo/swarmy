import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';

interface PasswordStepProps {
  onSubmit: (password: string) => Promise<void>;
  submitLabel: string;
}

/** Re-auth: confirm the account password before a 2FA change. */
export function PasswordStep({ onSubmit, submitLabel }: PasswordStepProps): React.JSX.Element {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="mfa-password">Your password</Label>
        <Input
          id="mfa-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={busy || !password}>
        {busy ? 'Checking…' : submitLabel}
      </Button>
    </form>
  );
}
