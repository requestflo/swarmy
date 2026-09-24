import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button, Input, Label, toast } from '@swarmy/ui';
import type { AuthFields, AuthMode } from './use-auth-submit';

interface AuthFormProps {
  mode: AuthMode;
  busy: boolean;
  onSubmit: (fields: AuthFields) => Promise<void>;
}

/**
 * Password sign-in / sign-up. Email is optional on swarmy: sign-in takes a
 * username or an email; sign-up asks for a username and an optional email.
 */
export function AuthForm({ mode, busy, onSubmit }: AuthFormProps): React.JSX.Element {
  const [name, setName] = React.useState('');
  const [login, setLogin] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const signup = mode === 'signup';

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await onSubmit({ name, login: login.trim(), email: email.trim(), password });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'authentication failed');
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {signup && (
        <div className="grid gap-2">
          <Label htmlFor="name" className="mono-label">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="login" className="mono-label">{signup ? 'Username' : 'Username or email'}</Label>
        <Input
          id="login"
          autoComplete="username"
          autoCapitalize="none"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          pattern={signup ? '[A-Za-z0-9_.]{2,40}' : undefined}
          title={signup ? '2–40 letters, digits, dots or underscores' : undefined}
          required
        />
      </div>
      {signup && (
        <div className="grid gap-2">
          <Label htmlFor="email" className="mono-label">
            Email <span className="text-muted-foreground font-normal normal-case">(optional)</span>
          </Label>
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="password" className="mono-label">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete={signup ? 'new-password' : 'current-password'}
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
