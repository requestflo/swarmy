import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button, Input, Label, toast } from '@swarmy/ui';
import type { AuthFields, AuthMode } from './use-auth-submit';

interface AuthFormProps {
  mode: AuthMode;
  busy: boolean;
  onSubmit: (fields: AuthFields) => Promise<void>;
}

/** Email + password form for both sign-in and sign-up (sign-up adds a name). */
export function AuthForm({ mode, busy, onSubmit }: AuthFormProps): React.JSX.Element {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await onSubmit({ name, email, password });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'authentication failed');
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {mode === 'signup' && (
        <div className="grid gap-2">
          <Label htmlFor="name" className="mono-label">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="email" className="mono-label">Email</Label>
        <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password" className="mono-label">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <Button type="submit" disabled={busy} className="mt-2 w-full">
        {busy && <Loader2Icon className="animate-spin" />}
        {mode === 'signin' ? 'Sign in' : 'Create account'}
      </Button>
    </form>
  );
}
