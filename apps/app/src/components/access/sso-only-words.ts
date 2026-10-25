import type { SignInMethod } from './use-signin-methods';

/** `security.ssoOnly.get`: the switch, the providers that can sign people in, and whether it keeps you in. */
export interface SsoOnlyState {
  on: boolean;
  ready: Array<{ providerId: string; protocol: 'oidc' | 'saml'; displayName: string }>;
  keepsYouSignedIn: boolean;
}

/** "Okta" · "Okta or Entra ID" · "your company sign-in" (none ready). */
export function providerNames(ready: SsoOnlyState['ready']): string {
  const names = ready.map((p) => p.displayName);
  if (names.length === 0) return 'your company sign-in';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** The sentence under the switch: what is true now. */
export function ssoOnlyLine(s: SsoOnlyState): string {
  if (s.on) {
    return `Members sign in only with ${providerNames(s.ready)}. Passwords, social accounts, email links and passkeys don’t work for them.`;
  }
  if (s.ready.length === 0) return 'Anyone can sign in any way that is on. Set up company sign-in to make it the only way in.';
  return `Members can also use a password or a social account. Turn this on to make ${providerNames(s.ready)} the only way in.`;
}

/** What turning it on does, said before it happens. */
export const TURN_ON_CONSEQUENCE = 'Turning it on signs out anyone who is signed in another way, right away.';

/** The break-glass note (boards 48 and 56). */
export const BREAK_GLASS_NOTE =
  'Owners can still sign in with their password and a two-factor code, in case your identity provider is down. Each time is recorded in Activity.';

/** Why the switch can't be turned on yet, or null. */
export function ssoOnlyBlocker(s: SsoOnlyState, role: 'owner' | 'admin' | 'member'): string | null {
  if (s.on) return null;
  if (s.ready.length === 0) return 'Set up company sign-in below first: no provider can sign people in yet.';
  if (!s.keepsYouSignedIn) {
    return role === 'owner'
      ? 'Sign in with SSO, or with your password and a two-factor code, first: turning this on now would sign you out.'
      : 'Sign in with SSO first: turning this on now would sign you out.';
  }
  return null;
}

/** The sign-in rows with the switch applied: the password row becomes the owners' break-glass. */
export function applySsoOnly(methods: SignInMethod[], on: boolean): SignInMethod[] {
  if (!on) return methods;
  return methods.map((m) => {
    if (m.kind === 'password') {
      return { ...m, detail: 'owners only, with a two-factor code, for when SSO is down', word: 'Owners', tech: 'requireSso: true · password + 2FA, owners only, audited' };
    }
    // Social, magic link, passkey: refused for everyone in this workspace (break-glass is password + 2FA).
    if (m.kind === 'sso' || !m.enabled) return m;
    return { ...m, enabled: false, detail: `${m.detail} · off here while members sign in with SSO only`, word: 'Off' };
  });
}

/** The invite option's line. */
export function ssoInviteLine(o: { forced: boolean; ready: SsoOnlyState['ready']; email: boolean }): string {
  if (o.forced) return 'Every invite is, while members sign in with SSO only.';
  if (o.ready.length === 0) return 'Set up company sign-in to use this.';
  return `They join by signing in with ${providerNames(o.ready)}${o.email ? ' as that address' : ''}.`;
}
