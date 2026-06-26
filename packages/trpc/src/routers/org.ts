import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, publicProcedure, router } from '../trpc';

export interface WhoAmI {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  activeOrgId: string | null;
}

export interface OrgView {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
}

export const orgRouter = router({
  whoami: publicProcedure.query(({ ctx }): WhoAmI | null => {
    if (!ctx.user) return null;
    return {
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name ?? null,
      image: ctx.user.image ?? null,
      activeOrgId: ctx.activeOrgId,
    };
  }),

  currentOrg: protectedProcedure.query(async ({ ctx }): Promise<OrgView | null> => {
    if (!ctx.activeOrgId) return null;
    const membership = await ctx.db.member.findFirst({
      where: { organizationId: ctx.activeOrgId, userId: ctx.user!.id },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    if (!membership) return null;
    return {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role as OrgView['role'],
    };
  }),

  listOrgs: protectedProcedure.query(async ({ ctx }): Promise<OrgView[]> => {
    const memberships = await ctx.db.member.findMany({
      where: { userId: ctx.user!.id },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role as OrgView['role'],
    }));
  }),

  members: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.activeOrgId) return [];
    const members = await ctx.db.member.findMany({
      where: { organizationId: ctx.activeOrgId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });
    return members.map((m) => ({
      id: m.id,
      role: m.role,
      user: m.user,
      joinedAt: m.createdAt.toISOString(),
    }));
  }),

  switchOrg: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.member.findFirst({
        where: { organizationId: input.orgId, userId: ctx.user!.id },
        select: { id: true },
      });
      if (!membership) throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member' });
      await ctx.auth.api.setActiveOrganization({
        headers: ctx.reqHeaders,
        body: { organizationId: input.orgId },
      });
      return { activeOrgId: input.orgId };
    }),
});
