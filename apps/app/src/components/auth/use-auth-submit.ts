import * as React from 'react';
import { authClient } from '@swarmy/auth/client';

export type AuthMode = 'signin' | 'signup';

export interface AuthFields {
  name: string;
  email: string;
  password: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `org-${Date.now()}`;
}

/**
 * Sign in / sign up, then land the user in an org. Arriving via an invite link
 * (`inviteId`) accepts that invitation and activates its org; an open-registration
 * sign-up without one creates the user's own first team (the server refuses that
 * on an invite-only controller).
 *
 * `'two-factor'` means the password was right but the account has 2FA: no
 * session yet. The caller shows the code step, then calls `finish('signin')`.
 */
export type AuthResult = 'done' | 'two-factor';

export function useAuthSubmit(inviteId: string | undefined): {
  busy: boolean;
  submit: (mode: AuthMode, fields: AuthFields) => Promise<AuthResult>;
  finish: (mode: AuthMode, fields?: Partial<AuthFields>) => Promise<void>;
} {
  const [busy, setBusy] = React.useState(false);

  async function submit(mode: AuthMode, fields: AuthFields): Promise<AuthResult> {
    const { name, email, password } = fields;
    setBusy(true);
    try {
      if (mode === 'signup') {
        const res = await authClient.signUp.email({ email, password, name });
        if (res.error) throw new Error(res.error.message ?? 'sign up failed');
      } else {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message ?? 'sign in failed');
        if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return 'two-factor';
      }
      await finish(mode, fields);
      return 'done';
    } finally {
      setBusy(false);
    }
  }

  /** Post-auth: accept the invite, or create the first team on an open sign-up. */
  async function finish(mode: AuthMode, { name = '', email = '' }: Partial<AuthFields> = {}): Promise<void> {
    if (inviteId) {
      const accepted = await authClient.organization.acceptInvitation({ invitationId: inviteId });
      if (accepted.error) throw new Error(accepted.error.message ?? 'could not accept the invitation');
      const orgId = accepted.data?.invitation.organizationId;
      if (orgId) await authClient.organization.setActive({ organizationId: orgId });
    } else if (mode === 'signup') {
      const org = await authClient.organization.create({
        name: `${name || email.split('@')[0]}'s team`,
        slug: slugify(name || email),
      });
      if (org.error) throw new Error(org.error.message ?? 'could not create your team');
      if (org.data?.id) await authClient.organization.setActive({ organizationId: org.data.id });
    }
  }

  return { busy, submit, finish };
}
