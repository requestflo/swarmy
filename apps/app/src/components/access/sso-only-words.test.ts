import { describe, expect, it } from 'bun:test';
import { applySsoOnly, providerNames, ssoInviteLine, ssoOnlyBlocker, ssoOnlyLine, type SsoOnlyState } from './sso-only-words';
import type { SignInMethod } from './use-signin-methods';

const okta = { providerId: 'okta', protocol: 'oidc' as const, displayName: 'Okta' };
const entra = { providerId: 'entra', protocol: 'saml' as const, displayName: 'Entra ID' };
const state = (o: Partial<SsoOnlyState> = {}): SsoOnlyState => ({ on: false, ready: [okta], keepsYouSignedIn: true, ...o });

describe('sso-only words', () => {
  it('names the providers in plain words', () => {
    expect(providerNames([])).toBe('your company sign-in');
    expect(providerNames([okta])).toBe('Okta');
    expect(providerNames([okta, entra])).toBe('Okta or Entra ID');
  });

  it('says what is true now', () => {
    expect(ssoOnlyLine(state({ on: true }))).toBe(
      'Members sign in only with Okta. Passwords, social accounts, email links and passkeys don’t work for them.',
    );
    expect(ssoOnlyLine(state())).toBe('Members can also use a password or a social account. Turn this on to make Okta the only way in.');
  });

  it('explains why it can’t be turned on', () => {
    expect(ssoOnlyBlocker(state({ ready: [] }), 'admin')).toBe('Set up company sign-in below first: no provider can sign people in yet.');
    expect(ssoOnlyBlocker(state({ keepsYouSignedIn: false }), 'admin')).toBe('Sign in with SSO first: turning this on now would sign you out.');
    expect(ssoOnlyBlocker(state(), 'admin')).toBeNull();
    expect(ssoOnlyBlocker(state({ on: true, keepsYouSignedIn: false }), 'admin')).toBeNull();
  });

  it('turns the password row into the owners’ break-glass and the rest off', () => {
    const rows: SignInMethod[] = [
      { id: 'sso-1', label: 'Company sign-in (okta)', kind: 'sso', enabled: true, detail: 'for anyone @acme.test' },
      { id: 'github', label: 'GitHub', kind: 'social', enabled: true, detail: 'set up' },
      { id: 'passkey', label: 'Passkeys', kind: 'method', enabled: false, detail: 'a fingerprint' },
      { id: 'password', label: 'Username and password', kind: 'password', enabled: true, detail: 'always on; two-factor optional' },
    ];
    expect(applySsoOnly(rows, false)).toBe(rows);
    const on = applySsoOnly(rows, true);
    expect(on[0]).toEqual(rows[0]!);
    expect(on[1]).toMatchObject({ enabled: false, word: 'Off', detail: 'set up · off here while members sign in with SSO only' });
    expect(on[2]).toEqual(rows[2]!);
    expect(on[3]).toMatchObject({ word: 'Owners', detail: 'owners only, with a two-factor code, for when SSO is down' });
  });

  it('words the invite option', () => {
    expect(ssoInviteLine({ forced: true, ready: [okta], email: true })).toBe('Every invite is, while members sign in with SSO only.');
    expect(ssoInviteLine({ forced: false, ready: [], email: false })).toBe('Set up company sign-in to use this.');
    expect(ssoInviteLine({ forced: false, ready: [okta], email: true })).toBe('They join by signing in with Okta as that address.');
  });
});
