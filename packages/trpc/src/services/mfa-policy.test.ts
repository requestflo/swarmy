import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SECURITY_POLICY,
  nextEnforcedSince,
  stepUpDecision,
  twoFactorRequirement,
  type SecurityPolicy,
} from './mfa-policy';

const DAY = 86_400_000;
const T0 = new Date('2026-09-01T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const policy = (p: Partial<SecurityPolicy> = {}): SecurityPolicy => ({
  ...DEFAULT_SECURITY_POLICY,
  require2fa: 'admins',
  graceDays: 7,
  enforcedSince: T0,
  ...p,
});
const base = { enrolled: false, ssoOnly: false, memberSince: at(-100) };

describe('twoFactorRequirement — the org "require 2FA" policy', () => {
  it('off covers nobody', () => {
    expect(twoFactorRequirement({ ...base, policy: policy({ require2fa: 'off' }), role: 'owner', now: at(99) }).standing).toBe(
      'not_required',
    );
  });

  it('"admins" covers owner + admin, not members', () => {
    expect(twoFactorRequirement({ ...base, policy: policy(), role: 'member', now: at(99) }).standing).toBe('not_required');
    expect(twoFactorRequirement({ ...base, policy: policy(), role: 'admin', now: at(99) }).standing).toBe('blocked');
    expect(twoFactorRequirement({ ...base, policy: policy(), role: 'owner', now: at(99) }).standing).toBe('blocked');
  });

  it('grants a grace period from enforcement, then blocks', () => {
    const r = twoFactorRequirement({ ...base, policy: policy(), role: 'admin', now: at(3) });
    expect(r.standing).toBe('grace');
    expect(r.deadline).toEqual(at(7));
    expect(twoFactorRequirement({ ...base, policy: policy(), role: 'admin', now: at(7) }).standing).toBe('blocked');
  });

  it('a member who joins after enforcement gets their own grace period', () => {
    const r = twoFactorRequirement({ ...base, memberSince: at(20), policy: policy(), role: 'admin', now: at(22) });
    expect(r).toEqual({ standing: 'grace', deadline: at(27) });
  });

  it('enrolled members are compliant; SSO-only members are exempt only while IdP MFA is trusted', () => {
    expect(
      twoFactorRequirement({ ...base, enrolled: true, policy: policy({ require2fa: 'all' }), role: 'member', now: at(99) })
        .standing,
    ).toBe('enrolled');
    expect(twoFactorRequirement({ ...base, ssoOnly: true, policy: policy(), role: 'admin', now: at(99) }).standing).toBe(
      'exempt_sso',
    );
    expect(
      twoFactorRequirement({ ...base, ssoOnly: true, policy: policy({ trustIdpMfa: false }), role: 'admin', now: at(99) })
        .standing,
    ).toBe('blocked');
  });

  it('never blocks retroactively when enforcedSince is missing', () => {
    expect(
      twoFactorRequirement({ ...base, policy: policy({ enforcedSince: null }), role: 'admin', now: at(99) }).standing,
    ).toBe('grace');
  });

  it('clamps an out-of-range grace to 30 days', () => {
    const r = twoFactorRequirement({ ...base, policy: policy({ graceDays: 999 }), role: 'admin', now: at(1) });
    expect(r.deadline).toEqual(at(30));
  });
});

describe('nextEnforcedSince', () => {
  const now = at(10);
  it('starts the clock off → on and clears it on off', () => {
    expect(nextEnforcedSince(policy({ require2fa: 'off', enforcedSince: null }), 'admins', now)).toEqual(now);
    expect(nextEnforcedSince(policy(), 'off', now)).toBeNull();
  });
  it('restarts when widening admins → all, keeps it otherwise', () => {
    expect(nextEnforcedSince(policy({ require2fa: 'admins' }), 'all', now)).toEqual(now);
    expect(nextEnforcedSince(policy({ require2fa: 'all' }), 'admins', now)).toEqual(T0);
    expect(nextEnforcedSince(policy({ require2fa: 'admins' }), 'admins', now)).toEqual(T0);
  });
});

describe('stepUpDecision — terminal requireMfa', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const win = 15 * 60_000;
  it('passes when the policy does not require MFA', () => {
    expect(stepUpDecision({ requireMfa: false, mfaMaxAgeMs: win, enrolled: false, mfaVerifiedAt: null, now })).toEqual({
      ok: true,
    });
  });
  it('tells an unenrolled user to enrol, never lets them through', () => {
    const d = stepUpDecision({ requireMfa: true, mfaMaxAgeMs: win, enrolled: false, mfaVerifiedAt: now, now });
    expect(d.ok === false && d.swarmyCode).toBe('MFA_ENROLMENT_REQUIRED');
  });
  it('accepts a factor inside the window and demands a fresh one outside it', () => {
    const recent = new Date(now.getTime() - win + 1000);
    const stale = new Date(now.getTime() - win - 1000);
    expect(stepUpDecision({ requireMfa: true, mfaMaxAgeMs: win, enrolled: true, mfaVerifiedAt: recent, now }).ok).toBe(true);
    const d = stepUpDecision({ requireMfa: true, mfaMaxAgeMs: win, enrolled: true, mfaVerifiedAt: stale, now });
    expect(d.ok === false && d.swarmyCode).toBe('MFA_STEP_UP_REQUIRED');
    const never = stepUpDecision({ requireMfa: true, mfaMaxAgeMs: win, enrolled: true, mfaVerifiedAt: null, now });
    expect(never.ok).toBe(false);
  });
  it('rejects a verification stamped in the future (clock skew / tampering)', () => {
    const future = new Date(now.getTime() + 60_000);
    expect(stepUpDecision({ requireMfa: true, mfaMaxAgeMs: win, enrolled: true, mfaVerifiedAt: future, now }).ok).toBe(false);
  });
});
