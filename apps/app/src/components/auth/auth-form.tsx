import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button, Input, Label } from '@swarmy/ui';
import type { AuthFields, AuthMode } from './use-auth-submit';
import { AuthOriginError } from './auth-origin-error';

interface AuthFormProps {
  mode: AuthMode;
  busy: boolean;
  onSubmit: (fields: AuthFields) => Promise<void>;
  /** The controller's public dashboard URL — where to go after an origin rejection. */
  dashboardUrl?: string | null;
  /** The team's own sign-in is the page's action: the password button goes quiet (outline). */
  quiet?: boolean;
}

/**
 * Password sign-in / sign-up. Email is optional on swarmy: sign-in takes a
 * username or an email; sign-up asks for a username and an optional email.
 */
export function AuthForm({ mode, busy, onSubmit, dashboardUrl, quiet }: AuthFormProps): React.JSX.Element {
  const [name, setName] = React.useState('');
  const [login, setLogin] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const signup = mode === 'signup';
  // Shown inline under the form (a toast vanishes before an origin problem can be read).
  const [error, setError] = React.useState<unknown>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit({ name, login: login.trim(), email: email.trim(), password });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {signup && (
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="login">{signup ? 'Username' : 'Username or email'}</Label>
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
          <Label htmlFor="email">
            Email <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
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
      {error ? <AuthError error={error} dashboardUrl={dashboardUrl ?? null} /> : null}
      <Button type="submit" variant={quiet ? 'outline' : 'default'} disabled={busy} className="mt-2 w-full pointer-coarse:min-h-11">
        {busy && <Loader2Icon className="animate-spin" />}
        {mode === 'signin' ? 'Sign in' : 'Create account'}
      </Button>
    </form>
  );
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function AuthError({ error, dashboardUrl }: { error: unknown; dashboardUrl: string | null }): React.JSX.Element {
  if (error instanceof AuthOriginError) {
    const elsewhere = dashboardUrl && safeOrigin(dashboardUrl) !== error.origin ? dashboardUrl : null;
    return (
      <div role="alert" className="border-status-offline/40 bg-status-offline/10 rounded-xl border px-4 py-3 text-sm">
        <p className="text-tone-bad font-medium">This address isn't trusted for sign-in</p>
        <p className="text-muted-foreground mt-1">
          swarmy only accepts sign-in from addresses it knows it serves on, and{' '}
          <span className="font-mono text-[13px]">{error.origin}</span> isn't one of them.
          {elsewhere ? (
            <>
              {' '}Open the dashboard at{' '}
              <a className="text-foreground underline" href={elsewhere}>
                {elsewhere}
              </a>
              , or at the address the installer printed.
            </>
          ) : (
            ' Open the dashboard at the address the installer printed.'
          )}
        </p>
      </div>
    );
  }
  return (
    <p role="alert" className="text-tone-bad text-sm font-medium">
      {error instanceof Error ? error.message : 'authentication failed'}
    </p>
  );
}
