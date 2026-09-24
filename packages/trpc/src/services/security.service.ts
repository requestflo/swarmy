import { TRPCError } from '@trpc/server';
import type { DB } from '@swarmy/db';
import type { AuthedContext, OrgContext } from '../context';
import { writeAudit } from './audit.service';
import {
  DEFAULT_SECURITY_POLICY,
  MAX_GRACE_DAYS,
  nextEnforcedSince,
  REQUIRE_2FA_VALUES,
  stepUpDecision,
  twoFactorRequirement,
  type Require2fa,
  type Role,
  type SecurityPolicy,
  type TwoFactorStanding,
} from './mfa-policy';

/**
 * Account security (launch-blocker #7): the org "require 2FA" policy, a user's
 * own MFA status, the orgProcedure enrolment gate, terminal step-up, and the
 * admin/CLI 2FA reset. Enrolment itself is Better Auth (`/api/auth/two-factor/*`);
 * this module never touches TOTP secrets or backup codes.
 */

type Db = DB;

function asRequire2fa(v: string | null | undefined): Require2fa {
  return (REQUIRE_2FA_VALUES as readonly string[]).includes(v ?? '') ? (v as Require2fa) : 'off';
}

export async function getSecurityPolicy(db: Db, orgId: string): Promise<SecurityPolicy> {
  const row = await db.orgSecurityPolicy.findUnique({ where: { orgId } });
  if (!row) return { ...DEFAULT_SECURITY_POLICY };
  return {
    require2fa: asRequire2fa(row.require2fa),
    graceDays: row.graceDays,
    enforcedSince: row.enforcedSince,
    trustIdpMfa: row.trustIdpMfa,
  };
}

export async function setSecurityPolicy(
  ctx: OrgContext,
  patch: Partial<Pick<SecurityPolicy, 'require2fa' | 'graceDays' | 'trustIdpMfa'>>,
): Promise<SecurityPolicy> {
  const prev = await getSecurityPolicy(ctx.db, ctx.activeOrgId);
  const require2fa = patch.require2fa ?? prev.require2fa;
  const next: SecurityPolicy = {
    require2fa,
    graceDays: Math.min(Math.max(patch.graceDays ?? prev.graceDays, 0), MAX_GRACE_DAYS),
    trustIdpMfa: patch.trustIdpMfa ?? prev.trustIdpMfa,
    enforcedSince: nextEnforcedSince(prev, require2fa, new Date()),
  };
  // Never lock yourself out by saving: an admin turning the policy on who has
  // not enrolled gets the grace period like everyone else, and with 0 days
  // they must enrol first.
  if (next.graceDays === 0 && require2fa !== 'off' && !ctx.user.twoFactorEnabled) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Set up two-factor on your own account before requiring it with no grace period.',
      cause: { swarmyCode: 'MFA_ENROLMENT_REQUIRED' },
    });
  }
  await ctx.db.orgSecurityPolicy.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, ...next },
    update: { ...next },
  });
  await writeAudit(ctx, {
    action: 'security.policy.set',
    targetType: 'org',
    targetId: ctx.activeOrgId,
    metadata: { require2fa: next.require2fa, graceDays: next.graceDays, trustIdpMfa: next.trustIdpMfa },
  });
  return next;
}

/** True when the user has no password account: every sign-in is via an IdP. */
export async function isSsoOnly(db: Db, userId: string): Promise<boolean> {
  const credential = await db.account.findFirst({
    where: { userId, providerId: 'credential' },
    select: { id: true },
  });
  return !credential;
}

async function sessionMfa(db: Db, sessionId: string) {
  const row = await db.session.findUnique({
    where: { id: sessionId },
    select: { mfaVerifiedAt: true, mfaPending: true },
  });
  return { mfaVerifiedAt: row?.mfaVerifiedAt ?? null, mfaPending: row?.mfaPending ?? false };
}

export async function standingFor(
  db: Db,
  input: { orgId: string; userId: string; role: Role; memberSince: Date; enrolled: boolean; policy?: SecurityPolicy },
): Promise<{ standing: TwoFactorStanding; deadline: Date | null }> {
  const policy = input.policy ?? (await getSecurityPolicy(db, input.orgId));
  const base = { policy, role: input.role, enrolled: input.enrolled, memberSince: input.memberSince, now: new Date() };
  const first = twoFactorRequirement({ ...base, ssoOnly: false });
  // Only pay for the account lookup when the SSO exemption could change the answer.
  if ((first.standing === 'grace' || first.standing === 'blocked') && policy.trustIdpMfa) {
    return twoFactorRequirement({ ...base, ssoOnly: await isSsoOnly(db, input.userId) });
  }
  return first;
}

/**
 * The orgProcedure gate. Two refusals, both with a swarmyCode the dashboard
 * turns into a full-screen step:
 *  - MFA_CHALLENGE_REQUIRED: this session owes a second factor (a magic-link /
 *    social sign-in by an enrolled user). Cleared by an in-session code.
 *  - TWO_FACTOR_ENROLMENT_REQUIRED: the org requires 2FA for this role and the
 *    grace period is over. Cleared by enrolling.
 * Test doubles without the security models skip the gate; the real client
 * always has them.
 */
export async function enforceOrgMfa(
  db: Db,
  input: {
    user: { id: string; twoFactorEnabled?: boolean | null };
    session: { id: string };
    orgId: string;
    role: Role;
    memberSince: Date | undefined;
  },
): Promise<void> {
  const enrolled = input.user.twoFactorEnabled === true;
  if (enrolled && db.session) {
    const s = await sessionMfa(db, input.session.id);
    if (s.mfaPending) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Enter a code from your authenticator app to finish signing in.',
        cause: { swarmyCode: 'MFA_CHALLENGE_REQUIRED' },
      });
    }
    return; // enrolled ⇒ compliant with any org requirement
  }
  if (!(db as { orgSecurityPolicy?: unknown }).orgSecurityPolicy || !input.memberSince) return;
  const policy = await getSecurityPolicy(db, input.orgId);
  if (policy.require2fa === 'off') return;
  const { standing } = await standingFor(db, {
    orgId: input.orgId,
    userId: input.user.id,
    role: input.role,
    memberSince: input.memberSince,
    enrolled,
    policy,
  });
  if (standing === 'blocked') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This workspace requires two-factor authentication. Set up an authenticator app to continue.',
      cause: { swarmyCode: 'TWO_FACTOR_ENROLMENT_REQUIRED' },
    });
  }
}

/** The signed-in user's own MFA picture (reachable while blocked or pending). */
export async function myMfaStatus(ctx: AuthedContext) {
  const enrolled = ctx.user.twoFactorEnabled === true;
  const [session, hasPassword] = await Promise.all([
    sessionMfa(ctx.db, ctx.session.id),
    isSsoOnly(ctx.db, ctx.user.id).then((sso) => !sso),
  ]);
  let org: null | {
    require2fa: Require2fa;
    graceDays: number;
    standing: TwoFactorStanding;
    deadline: Date | null;
    stepUpWindowMs: number;
  } = null;
  if (ctx.activeOrgId) {
    const member = await ctx.db.member.findFirst({
      where: { organizationId: ctx.activeOrgId, userId: ctx.user.id },
      select: { role: true, createdAt: true },
    });
    if (member) {
      const policy = await getSecurityPolicy(ctx.db, ctx.activeOrgId);
      const { standing, deadline } = await standingFor(ctx.db, {
        orgId: ctx.activeOrgId,
        userId: ctx.user.id,
        role: member.role as Role,
        memberSince: member.createdAt,
        enrolled,
        policy,
      });
      const terminal = await ctx.db.terminalPolicy.findUnique({
        where: { orgId: ctx.activeOrgId },
        select: { mfaMaxAgeMs: true },
      });
      org = {
        require2fa: policy.require2fa,
        graceDays: policy.graceDays,
        standing,
        deadline,
        stepUpWindowMs: terminal?.mfaMaxAgeMs ?? 900_000,
      };
    }
  }
  return {
    enrolled,
    hasPassword,
    mfaVerifiedAt: session.mfaVerifiedAt,
    mfaPending: session.mfaPending,
    org,
  };
}

/** Every member's 2FA standing, for the admin view. */
export async function listMemberMfa(ctx: OrgContext) {
  const policy = await getSecurityPolicy(ctx.db, ctx.activeOrgId);
  const members = await ctx.db.member.findMany({
    where: { organizationId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          twoFactorEnabled: true,
          accounts: { select: { providerId: true } },
        },
      },
    },
  });
  const now = new Date();
  return members.map((m) => {
    const ssoOnly = !m.user.accounts.some((a) => a.providerId === 'credential');
    const { standing, deadline } = twoFactorRequirement({
      policy,
      role: m.role as Role,
      enrolled: m.user.twoFactorEnabled,
      ssoOnly,
      memberSince: m.createdAt,
      now,
    });
    return {
      memberId: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      enrolled: m.user.twoFactorEnabled,
      ssoOnly,
      standing,
      deadline,
    };
  });
}

/** Remove a user's authenticator + backup codes and sign them out everywhere. */
async function wipeTwoFactor(db: Db, userId: string): Promise<void> {
  await db.twoFactor.deleteMany({ where: { userId } });
  await db.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } });
  await db.session.deleteMany({ where: { userId } });
}

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Admin reset of another member's 2FA (lost phone, codes gone). Refuses:
 * yourself (use Disable, which re-checks your password), a member who outranks
 * you, and anyone who also belongs to another workspace — a user is global, so
 * one org's admin must not weaken an account another org depends on (the
 * controller CLI covers that case). Signs the member out everywhere.
 */
export async function resetMemberTwoFactor(ctx: OrgContext, memberId: string) {
  const member = await ctx.db.member.findFirst({
    where: { id: memberId, organizationId: ctx.activeOrgId },
    select: { id: true, role: true, userId: true },
  });
  if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'member not found' });
  if (member.userId === ctx.user.id) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Use Disable two-factor on your own profile.' });
  }
  if (ROLE_RANK[member.role as Role] > ROLE_RANK[ctx.membership.role]) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `An ${ctx.membership.role} cannot reset an ${member.role}.` });
  }
  const elsewhere = await ctx.db.member.count({
    where: { userId: member.userId, organizationId: { not: ctx.activeOrgId } },
  });
  if (elsewhere > 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This person also belongs to another workspace. Reset their 2FA from the controller CLI.',
      cause: { swarmyCode: 'MULTI_ORG_USER' },
    });
  }
  await wipeTwoFactor(ctx.db, member.userId);
  await writeAudit(ctx, {
    action: 'security.twoFactor.reset',
    targetType: 'member',
    targetId: member.id,
    metadata: { userId: member.userId },
  });
  return { ok: true as const };
}

/**
 * Controller-CLI recovery (`bun run reset-2fa --email …`): the locked-out-owner
 * path. Whoever can exec into the controller already holds the database, so
 * this adds no power; it is audited as a `system` action in every org the user
 * belongs to.
 */
export async function resetTwoFactorByEmail(db: Db, email: string) {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
  if (!user) return { found: false as const };
  const orgs = await db.member.findMany({ where: { userId: user.id }, select: { organizationId: true } });
  await wipeTwoFactor(db, user.id);
  for (const { organizationId } of orgs) {
    await writeAudit(
      { db, activeOrgId: organizationId, user: null },
      {
        action: 'security.twoFactor.reset',
        targetType: 'user',
        targetId: user.id,
        actorType: 'system',
        metadata: { via: 'controller-cli' },
      },
    );
  }
  return { found: true as const, orgs: orgs.length };
}

/**
 * Terminal step-up. Refuses (and audits) a shell open when the org requires a
 * recent second factor and this session has none within the window.
 */
export async function assertTerminalStepUp(
  ctx: OrgContext,
  policy: { requireMfa: boolean; mfaMaxAgeMs: number },
  target: { kind: 'container' | 'nodeShell'; targetType: string; targetId: string },
): Promise<void> {
  if (!policy.requireMfa) return;
  const { mfaVerifiedAt } = await sessionMfa(ctx.db, ctx.session.id);
  const decision = stepUpDecision({
    requireMfa: policy.requireMfa,
    mfaMaxAgeMs: policy.mfaMaxAgeMs,
    enrolled: ctx.user.twoFactorEnabled === true,
    mfaVerifiedAt,
    now: new Date(),
  });
  if (decision.ok) return;
  await writeAudit(ctx, {
    action: 'terminal.stepup.required',
    targetType: target.targetType,
    targetId: target.targetId,
    metadata: { kind: target.kind, reason: decision.swarmyCode },
  });
  throw new TRPCError({ code: 'FORBIDDEN', message: decision.message, cause: { swarmyCode: decision.swarmyCode } });
}
