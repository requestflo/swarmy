import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { authClient, usernamePlaceholderEmail } from '@swarmy/auth/client';
import { useTRPC } from '@/integrations/trpc';
import { clearInviteCookie } from './invite-cookie';
import { followRedirect, type AuthData } from './auth-redirect';
import { AuthOriginError, isOriginRejection } from './auth-origin-error';

export type AuthMode = 'signin' | 'signup';


export interface AuthFields {
  name: string;
  /** Sign-in: a username or an email. Sign-up: the username. */
  login: string;
  /** Sign-up only, optional. */
  email: string;
  password: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `org-${Date.now()}`;
}

/**
 * `'two-factor'`: the password was right but the account has 2FA and no session
 * exists yet (the caller shows the code step, then calls `finish('signin')`).
 * `'redirect'`: an OIDC authorize flow (e.g. NetBird) resumed; the browser is
 * already navigating away.
 */
export type AuthResult = 'done' | 'two-factor' | 'redirect';

/**
 * Sign in / sign up, then land the user in an org. An invite link (`inviteId`)
 * is redeemed by the sign-in itself (cookie + server hook); `finish` calls the
 * idempotent accept as a fallback. An open-registration sign-up without an
 * invite creates the user's own first team.
 */
export function useAuthSubmit(inviteId: string | undefined): {
  busy: boolean;
  submit: (mode: AuthMode, fields: AuthFields) => Promise<AuthResult>;
  finish: (mode: AuthMode, fields?: Partial<AuthFields>) => Promise<void>;
} {
  const trpc = useTRPC();
  const accept = useMutation(trpc.authConfig.acceptInvite.mutationOptions());
  const [busy, setBusy] = React.useState(false);

  async function submit(mode: AuthMode, fields: AuthFields): Promise<AuthResult> {
    const { name, login, email, password } = fields;
    setBusy(true);
    try {
      let res: { data: unknown; error: { message?: string; code?: string } | null };
      if (mode === 'signup') {
        const username = login.toLowerCase();
        res = await authClient.signUp.email({
          email: email || usernamePlaceholderEmail(username),
          password,
          name: name || username,
          username,
        });
      } else if (login.includes('@')) {
        res = await authClient.signIn.email({ email: login, password });
      } else {
        res = await authClient.signIn.username({ username: login.toLowerCase(), password });
      }
      if (res.error && isOriginRejection(res.error)) throw new AuthOriginError(window.location.origin);
      if (res.error) throw new Error(res.error.message ?? (mode === 'signup' ? 'sign up failed' : 'sign in failed'));
      if ((res.data as AuthData | null)?.twoFactorRedirect) return 'two-factor';
      if (followRedirect(res.data)) return 'redirect';
      await finish(mode, fields);
      return 'done';
    } finally {
      setBusy(false);
    }
  }

  async function finish(mode: AuthMode, { name = '', login = '' }: Partial<AuthFields> = {}): Promise<void> {
    if (inviteId) {
      await accept.mutateAsync({ id: inviteId });
      clearInviteCookie();
    } else if (mode === 'signup') {
      const who = name || login;
      const org = await authClient.organization.create({ name: `${who}'s team`, slug: slugify(who) });
      if (org.error) throw new Error(org.error.message ?? 'could not create your team');
      if (org.data?.id) await authClient.organization.setActive({ organizationId: org.data.id });
    }
  }

  return { busy, submit, finish };
}
