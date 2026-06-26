import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { BaseContext } from './context';

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
    select: { role: true, organizationId: true },
  });
  if (!member) throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of active org' });
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
