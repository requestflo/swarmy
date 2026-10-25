import { describe, expect, it } from 'bun:test';
import {
  parseSignInMethod,
  pickLandingOrg,
  signInFromPath,
  signInMethod,
  ssoSignInDecision,
  type SignIn,
  type SsoDecisionInput,
} from './sso-enforcement';

describe('signInFromPath: which sign-in a session-minting path is', () => {
  const cases: Array<[string, Record<string, unknown> | null, Record<string, unknown> | null, SignIn | null]> = [
    ['/oauth2/callback/:providerId', { providerId: 'okta' }, null, { kind: 'sso', providerId: 'okta' }],
    ['/oauth2/callback/okta', null, null, { kind: 'sso', providerId: 'okta' }],
    ['/sso/saml2/sp/acs/:providerId', { providerId: 'adfs' }, null, { kind: 'sso', providerId: 'adfs' }],
    ['/sign-in/email', null, null, { kind: 'password', providerId: null }],
    ['/sign-in/username', null, null, { kind: 'password', providerId: null }],
    ['/sign-up/email', null, null, { kind: 'password', providerId: null }],
    ['/two-factor/verify-totp', null, null, { kind: 'password_2fa', providerId: null }],
    ['/two-factor/verify-backup-code', null, null, { kind: 'password_2fa', providerId: null }],
    ['/callback/:id', { id: 'github' }, null, { kind: 'social', providerId: 'github' }],
    ['/sign-in/social', null, { provider: 'google' }, { kind: 'social', providerId: 'google' }],
    ['/magic-link/verify', null, null, { kind: 'email_link', providerId: null }],
    ['/verify-email', null, null, { kind: 'email_link', providerId: null }],
    ['/sign-in/passkey', null, null, { kind: 'passkey', providerId: null }],
    ['/change-password', null, null, null],
    ['/two-factor/enable', null, null, null],
    ['/oauth2/callback/:providerId', null, null, null],
  ];
  for (const [path, params, body, want] of cases) {
    it(`${path} ${params ? JSON.stringify(params) : ''}`, () => {
      expect(signInFromPath(path, params, body)).toEqual(want);
    });
  }
});

describe('signInMethod / parseSignInMethod round-trip', () => {
  it('stores provider ids for sso and social, the kind otherwise', () => {
    expect(signInMethod({ kind: 'sso', providerId: 'okta' })).toBe('sso:okta');
    expect(signInMethod({ kind: 'social', providerId: 'github' })).toBe('social:github');
    expect(signInMethod({ kind: 'password_2fa', providerId: null })).toBe('password_2fa');
    expect(parseSignInMethod('sso:okta')).toEqual({ kind: 'sso', providerId: 'okta' });
    expect(parseSignInMethod('password')).toEqual({ kind: 'password', providerId: null });
  });
  it('reads nothing into a legacy or unknown value', () => {
    expect(parseSignInMethod(null)).toBeNull();
    expect(parseSignInMethod('wizard:merlin')).toBeNull();
  });
});

const sso = (providerId: string): SignIn => ({ kind: 'sso', providerId });
const k = (kind: SignIn['kind']): SignIn => ({ kind, providerId: null });

describe('ssoSignInDecision: may this sign-in be active in the org?', () => {
  const base: SsoDecisionInput = {
    enforced: true,
    signIn: k('password'),
    ssoOrgId: null,
    orgId: 'org-a',
    role: 'member',
    secondFactor: 'none',
  };
  const table: Array<[string, Partial<SsoDecisionInput>, 'allow' | 'break_glass' | 'SSO_REQUIRED' | 'BREAK_GLASS_NEEDS_2FA']> = [
    ['switch off: password is fine', { enforced: false }, 'allow'],
    ['switch off: social is fine', { enforced: false, signIn: k('social') }, 'allow'],
    ['own SSO', { signIn: sso('okta'), ssoOrgId: 'org-a' }, 'allow'],
    ['another org’s SSO', { signIn: sso('evil'), ssoOrgId: 'org-b' }, 'SSO_REQUIRED'],
    ['member password', {}, 'SSO_REQUIRED'],
    ['admin password + 2FA', { role: 'admin', signIn: k('password_2fa') }, 'SSO_REQUIRED'],
    ['member social', { signIn: k('social') }, 'SSO_REQUIRED'],
    ['member email link', { signIn: k('email_link') }, 'SSO_REQUIRED'],
    ['member passkey', { signIn: k('passkey') }, 'SSO_REQUIRED'],
    ['unknown (legacy) session', { signIn: null }, 'SSO_REQUIRED'],
    ['owner password, no 2FA', { role: 'owner' }, 'BREAK_GLASS_NEEDS_2FA'],
    ['owner password step, 2FA challenge next', { role: 'owner', secondFactor: 'will_challenge' }, 'break_glass'],
    ['owner password, code passed in-session', { role: 'owner', secondFactor: 'verified' }, 'break_glass'],
    ['owner password + 2FA challenge', { role: 'owner', signIn: k('password_2fa') }, 'break_glass'],
    ['owner own SSO', { role: 'owner', signIn: sso('okta'), ssoOrgId: 'org-a' }, 'allow'],
    ['owner social', { role: 'owner', signIn: k('social') }, 'SSO_REQUIRED'],
    ['owner passkey', { role: 'owner', signIn: k('passkey'), secondFactor: 'verified' }, 'SSO_REQUIRED'],
    ['owner email link', { role: 'owner', signIn: k('email_link'), secondFactor: 'verified' }, 'SSO_REQUIRED'],
  ];
  for (const [name, over, want] of table) {
    it(name, () => {
      const d = ssoSignInDecision({ ...base, ...over });
      const got = d.ok ? (d.breakGlass ? 'break_glass' : 'allow') : d.code;
      expect(got).toBe(want);
    });
  }
});

describe('pickLandingOrg', () => {
  const decide = (enforced: Set<string>) => (m: { orgId: string }) =>
    ssoSignInDecision({ enforced: enforced.has(m.orgId), signIn: k('password'), ssoOrgId: null, orgId: m.orgId, role: 'member', secondFactor: 'none' });
  const ms = [{ orgId: 'old' }, { orgId: 'new' }];
  it('lands in the oldest org the sign-in may be active in', () => {
    expect(pickLandingOrg(ms, decide(new Set())).orgId).toBe('old');
    expect(pickLandingOrg(ms, decide(new Set(['old']))).orgId).toBe('new');
  });
  it('with none, answers the oldest org’s refusal', () => {
    const r = pickLandingOrg(ms, decide(new Set(['old', 'new'])));
    expect(r.orgId).toBeNull();
    expect(r.decision).toMatchObject({ ok: false, code: 'SSO_REQUIRED' });
  });
});
