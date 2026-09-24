import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { BaseContext } from './context';
import { enforceOrgMfa } from './services/security.service';
import { INSTANCE_OWNER_REQUIRED, isInstanceOwner } from './services/instance-owner';

const t = initTRPC.context<BaseContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      swarmyCode: (error.cause as { swarmyCode?: string } | undefined)?.swarmyCode,
    },
  }),
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;

// Inline middlewares so the context type accumulates down the chain.
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session || !ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { session: ctx.session, user: ctx.user } });
});

export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.activeOrgId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'No active organization' });
  }
  const member = await ctx.db.member.findFirst({
    where: { organizationId: ctx.activeOrgId, userId: ctx.user.id },
    select: { role: true, organizationId: true, createdAt: true },
  });
  if (!member) throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of active org' });
  // Account-security wall (launch-blocker #7): a session that still owes its
  // second factor, or a member past the org's 2FA grace period, reaches no org
  // data. Enrolment stays reachable (Better Auth + protectedProcedure `security.me`).
  await enforceOrgMfa(ctx.db, {
    user: ctx.user,
    session: ctx.session,
    orgId: ctx.activeOrgId,
    role: member.role as 'owner' | 'admin' | 'member',
    memberSince: member.createdAt,
  });
  return next({
    ctx: {
      activeOrgId: ctx.activeOrgId,
      membership: {
        role: member.role as 'owner' | 'admin' | 'member',
        orgId: member.organizationId,
      },
    },
  });
});

export const adminProcedure = orgProcedure.use(({ ctx, next }) => {
  if (ctx.membership.role === 'member') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'requires admin or owner' });
  }
  return next();
});

/**
 * Instance-wide configuration (rows with `orgId = null`: social providers,
 * magic link, passkeys). Org roles don't reach it — only the owner of the
 * controller's organization (the oldest org; one org per controller) may
 * write it. See services/instance-owner.ts.
 */
export const instanceOwnerProcedure = orgProcedure.use(async ({ ctx, next }) => {
  if (!(await isInstanceOwner(ctx.db, ctx.user.id))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: INSTANCE_OWNER_REQUIRED,
      cause: { swarmyCode: 'INSTANCE_OWNER_REQUIRED' },
    });
  }
  return next();
});
