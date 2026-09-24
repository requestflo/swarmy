import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { assertTerminalStepUp, enforceOrgMfa, resetMemberTwoFactor, setSecurityPolicy } from './security.service';

const DAY = 86_400_000;

interface MockState {
  policy?: { require2fa: string; graceDays: number; enforcedSince: Date | null; trustIdpMfa: boolean } | null;
  session?: { mfaVerifiedAt: Date | null; mfaPending: boolean };
  hasPassword?: boolean;
  members?: Array<{ id: string; role: string; userId: string; organizationId: string }>;
}

function mockDb(state: MockState, log: { audit: string[]; writes: string[] }) {
  return {
    orgSecurityPolicy: {
      findUnique: async () => state.policy ?? null,
      upsert: async () => {
        log.writes.push('policy.upsert');
        return {};
      },
    },
    session: {
      findUnique: async () => state.session ?? null,
      deleteMany: async () => void log.writes.push('session.deleteMany'),
    },
    account: { findFirst: async () => (state.hasPassword === false ? null : { id: 'acc' }) },
    member: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        state.members?.find((m) => m.id === where.id && m.organizationId === where.organizationId) ?? null,
      count: async ({ where }: { where: { userId: string; organizationId: { not: string } } }) =>
        state.members?.filter((m) => m.userId === where.userId && m.organizationId !== where.organizationId.not)
          .length ?? 0,
    },
    twoFactor: { deleteMany: async () => void log.writes.push('twoFactor.deleteMany') },
    user: { update: async () => void log.writes.push('user.update') },
    auditLog: {
      create: async ({ data }: { data: { action: string } }) => {
        log.audit.push(data.action);
        return {};
      },
    },
  } as unknown as DB;
}

function ctx(
  state: MockState,
  opts: { role?: 'owner' | 'admin' | 'member'; enrolled?: boolean } = {},
): { ctx: OrgContext; log: { audit: string[]; writes: string[] } } {
  const log = { audit: [] as string[], writes: [] as string[] };
  return {
    log,
    ctx: {
      db: mockDb(state, log),
      session: { id: 's1' },
      user: { id: 'me', email: 'me@x.io', name: 'Me', twoFactorEnabled: opts.enrolled ?? false },
      activeOrgId: 'org1',
      membership: { role: opts.role ?? 'owner', orgId: 'org1' },
      reqHeaders: new Headers(),
    } as unknown as OrgContext,
  };
}

async function swarmyCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(TRPCError);
    return ((e as TRPCError).cause as { swarmyCode?: string } | undefined)?.swarmyCode ?? (e as TRPCError).code;
  }
}

const longAgo = new Date(Date.now() - 60 * DAY);

describe('enforceOrgMfa — the orgProcedure wall', () => {
  const gate = (state: MockState, enrolled: boolean, role: 'owner' | 'admin' | 'member' = 'admin') =>
    enforceOrgMfa(mockDb(state, { audit: [], writes: [] }), {
      user: { id: 'u', twoFactorEnabled: enrolled },
      session: { id: 's1' },
      orgId: 'org1',
      role,
      memberSince: longAgo,
    });

  it('lets everyone through when the org has no policy', async () => {
    expect(await swarmyCode(gate({ policy: null }, false))).toBeUndefined();
  });

  it('blocks an unenrolled admin past the grace period', async () => {
    const policy = { require2fa: 'admins', graceDays: 7, enforcedSince: longAgo, trustIdpMfa: true };
    expect(await swarmyCode(gate({ policy }, false))).toBe('TWO_FACTOR_ENROLMENT_REQUIRED');
    expect(await swarmyCode(gate({ policy }, false, 'member'))).toBeUndefined();
  });

  it('keeps access during grace, and exempts SSO-only members', async () => {
    const fresh = { require2fa: 'all', graceDays: 7, enforcedSince: new Date(), trustIdpMfa: true };
    expect(await swarmyCode(gate({ policy: fresh }, false))).toBeUndefined();
    const old = { ...fresh, enforcedSince: longAgo };
    expect(await swarmyCode(gate({ policy: old, hasPassword: false }, false))).toBeUndefined();
  });

  it('refuses an enrolled user whose session still owes a code (magic-link sign-in)', async () => {
    const s = { mfaVerifiedAt: null, mfaPending: true };
    expect(await swarmyCode(gate({ session: s }, true))).toBe('MFA_CHALLENGE_REQUIRED');
    expect(await swarmyCode(gate({ session: { mfaVerifiedAt: new Date(), mfaPending: false } }, true))).toBeUndefined();
  });
});

describe('assertTerminalStepUp', () => {
  const policy = { requireMfa: true, mfaMaxAgeMs: 15 * 60_000 };
  const target = { kind: 'nodeShell' as const, targetType: 'node', targetId: 'n1' };

  it('refuses and audits a stale second factor', async () => {
    const { ctx: c, log } = ctx({ session: { mfaVerifiedAt: new Date(Date.now() - DAY), mfaPending: false } }, { enrolled: true });
    expect(await swarmyCode(assertTerminalStepUp(c, policy, target))).toBe('MFA_STEP_UP_REQUIRED');
    expect(log.audit).toEqual(['terminal.stepup.required']);
  });

  it('passes a fresh one, and anything when the policy is off', async () => {
    const { ctx: c, log } = ctx({ session: { mfaVerifiedAt: new Date(), mfaPending: false } }, { enrolled: true });
    expect(await swarmyCode(assertTerminalStepUp(c, policy, target))).toBeUndefined();
    const { ctx: c2 } = ctx({}, { enrolled: false });
    expect(await swarmyCode(assertTerminalStepUp(c2, { ...policy, requireMfa: false }, target))).toBeUndefined();
    expect(log.audit).toEqual([]);
  });

  it('sends an unenrolled user to enrolment', async () => {
    const { ctx: c } = ctx({ session: { mfaVerifiedAt: null, mfaPending: false } }, { enrolled: false });
    expect(await swarmyCode(assertTerminalStepUp(c, policy, target))).toBe('MFA_ENROLMENT_REQUIRED');
  });
});

describe('resetMemberTwoFactor', () => {
  const members = [
    { id: 'm-owner', role: 'owner', userId: 'owner', organizationId: 'org1' },
    { id: 'm-dev', role: 'member', userId: 'dev', organizationId: 'org1' },
    { id: 'm-multi', role: 'member', userId: 'multi', organizationId: 'org1' },
    { id: 'm-multi-b', role: 'owner', userId: 'multi', organizationId: 'org2' },
    { id: 'm-me', role: 'admin', userId: 'me', organizationId: 'org1' },
  ];

  it('wipes the factor, signs the member out, and audits', async () => {
    const { ctx: c, log } = ctx({ members }, { role: 'admin' });
    await resetMemberTwoFactor(c, 'm-dev');
    expect(log.writes).toEqual(['twoFactor.deleteMany', 'user.update', 'session.deleteMany']);
    expect(log.audit).toEqual(['security.twoFactor.reset']);
  });

  it('refuses yourself, a higher role, and a user in another workspace', async () => {
    const { ctx: c, log } = ctx({ members }, { role: 'admin' });
    expect(await swarmyCode(resetMemberTwoFactor(c, 'm-me'))).toBe('BAD_REQUEST');
    expect(await swarmyCode(resetMemberTwoFactor(c, 'm-owner'))).toBe('FORBIDDEN');
    expect(await swarmyCode(resetMemberTwoFactor(c, 'm-multi'))).toBe('MULTI_ORG_USER');
    expect(log.writes).toEqual([]);
  });
});

describe('setSecurityPolicy', () => {
  it('refuses a zero-grace requirement from an admin who has not enrolled (no self-lockout)', async () => {
    const { ctx: c, log } = ctx({ policy: null }, { enrolled: false });
    expect(await swarmyCode(setSecurityPolicy(c, { require2fa: 'admins', graceDays: 0 }))).toBe('MFA_ENROLMENT_REQUIRED');
    expect(log.writes).toEqual([]);
  });

  it('saves and audits otherwise', async () => {
    const { ctx: c, log } = ctx({ policy: null }, { enrolled: false });
    const next = await setSecurityPolicy(c, { require2fa: 'admins' });
    expect(next.require2fa).toBe('admins');
    expect(next.enforcedSince).toBeInstanceOf(Date);
    expect(log.writes).toEqual(['policy.upsert']);
    expect(log.audit).toEqual(['security.policy.set']);
  });
});
