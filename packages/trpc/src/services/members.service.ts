import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/**
 * Member attribute management (org admin). Attributes are the ABAC subject
 * attribute bag on `Member.attributes` (team, employment type, on-call, …).
 * `teamIds` is a conventional array attribute the engine reads for team-scoped
 * grants. These attributes feed the principal in `buildPrincipal`.
 */

export interface MemberView {
  id: string;
  role: 'owner' | 'admin' | 'member';
  user: { id: string; name: string | null; email: string | null };
  attributes: Record<string, unknown>;
}

export async function listMembers(ctx: OrgContext): Promise<MemberView[]> {
  const rows = await ctx.db.member.findMany({
    where: { organizationId: ctx.activeOrgId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((m) => ({
    id: m.id,
    role: m.role as MemberView['role'],
    user: m.user,
    attributes: (m.attributes as Record<string, unknown>) ?? {},
  }));
}

export interface SetMemberAttributesArgs {
  memberId: string;
  /** Replaces the member's attribute bag wholesale (validated JSON object). */
  attributes: Record<string, unknown>;
}

export async function setMemberAttributes(
  ctx: OrgContext,
  args: SetMemberAttributesArgs,
): Promise<MemberView> {
  const existing = await ctx.db.member.findFirst({
    where: { id: args.memberId, organizationId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!existing) throw notFound('member', args.memberId);
  await ctx.db.member.update({
    where: { id: args.memberId },
    data: { attributes: args.attributes as object },
  });
  await writeAudit(ctx, {
    action: 'member.setAttributes',
    targetType: 'member',
    targetId: args.memberId,
    metadata: { keys: Object.keys(args.attributes) },
  });
  const all = await listMembers(ctx);
  return all.find((m) => m.id === args.memberId)!;
}

// ── ReBAC grants (ResourceGrant CRUD) ──────────────────────────────────────

export interface GrantView {
  id: string;
  principalType: 'member' | 'team';
  principalId: string;
  resourceType: string;
  resourceId: string;
  relation: 'owner' | 'operator' | 'viewer';
}

export async function listGrants(ctx: OrgContext): Promise<GrantView[]> {
  const rows = await ctx.db.resourceGrant.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((g) => ({
    id: g.id,
    principalType: (g.principalType === 'team' ? 'team' : 'member') as 'member' | 'team',
    principalId: g.principalId,
    resourceType: g.resourceType,
    resourceId: g.resourceId,
    relation: g.relation as GrantView['relation'],
  }));
}

export interface CreateGrantArgs {
  principalType: 'member' | 'team';
  principalId: string;
  resourceType: 'node' | 'service' | 'stack';
  resourceId: string;
  relation: 'owner' | 'operator' | 'viewer';
}

export async function createGrant(ctx: OrgContext, args: CreateGrantArgs): Promise<GrantView> {
  const row = await ctx.db.resourceGrant.upsert({
    where: {
      principalType_principalId_resourceType_resourceId_relation: {
        principalType: args.principalType,
        principalId: args.principalId,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        relation: args.relation,
      },
    },
    create: { orgId: ctx.activeOrgId, ...args },
    update: {},
  });
  await writeAudit(ctx, {
    action: 'grant.create',
    targetType: args.resourceType,
    targetId: args.resourceId,
    metadata: { principalType: args.principalType, principalId: args.principalId, relation: args.relation },
  });
  return {
    id: row.id,
    principalType: args.principalType,
    principalId: args.principalId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    relation: args.relation,
  };
}

export async function deleteGrant(ctx: OrgContext, id: string): Promise<{ id: string; deleted: true }> {
  const row = await ctx.db.resourceGrant.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!row) throw notFound('grant', id);
  await ctx.db.resourceGrant.delete({ where: { id } });
  await writeAudit(ctx, { action: 'grant.delete', targetType: 'resource_grant', targetId: id });
  return { id, deleted: true };
}
