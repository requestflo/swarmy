import { parsePolicyDoc, PolicyParseError, defaultPolicyInputs } from '@swarmy/abac';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

export interface PolicyView {
  id: string;
  name: string;
  description: string | null;
  effect: 'permit' | 'forbid';
  source: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: Date;
}

function toView(row: {
  id: string;
  name: string;
  description: string | null;
  effect: string;
  source: string;
  priority: number;
  enabled: boolean;
  isdefault: boolean;
  updatedAt: Date;
}): PolicyView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    effect: row.effect as PolicyView['effect'],
    source: row.source,
    priority: row.priority,
    enabled: row.enabled,
    isDefault: row.isdefault,
    updatedAt: row.updatedAt,
  };
}

/**
 * Seed the behaviour-preserving default policy set for an org the first time the
 * policy UI is opened (idempotent). Keeps zero-config orgs identical to today.
 */
export async function ensureDefaultPolicies(ctx: OrgContext): Promise<void> {
  const count = await ctx.db.policy.count({ where: { orgId: ctx.activeOrgId } });
  if (count > 0) return;
  await ctx.db.policy.createMany({
    data: defaultPolicyInputs().map((p) => ({
      orgId: ctx.activeOrgId,
      name: p.name,
      effect: p.effect,
      source: p.source,
      priority: p.priority,
      enabled: true,
      isdefault: true,
      createdById: ctx.user.id,
    })),
  });
}

export async function listPolicies(ctx: OrgContext): Promise<PolicyView[]> {
  await ensureDefaultPolicies(ctx);
  const rows = await ctx.db.policy.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });
  return rows.map(toView);
}

export interface SetPolicyArgs {
  id?: string;
  name: string;
  description?: string;
  effect: 'permit' | 'forbid';
  source: string;
  priority?: number;
  enabled?: boolean;
}

/** Create or update a policy. Validates the source document before persisting. */
export async function setPolicy(ctx: OrgContext, args: SetPolicyArgs): Promise<PolicyView> {
  try {
    parsePolicyDoc(args.source);
  } catch (e) {
    if (e instanceof PolicyParseError) {
      throw new Error(`invalid policy: ${e.message}`);
    }
    throw e;
  }

  if (args.id) {
    const existing = await ctx.db.policy.findFirst({
      where: { id: args.id, orgId: ctx.activeOrgId },
      select: { id: true, isdefault: true },
    });
    if (!existing) throw notFound('policy', args.id);
    const row = await ctx.db.policy.update({
      where: { id: args.id },
      data: {
        name: args.name,
        description: args.description ?? null,
        effect: args.effect,
        source: args.source,
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      },
    });
    await writeAudit(ctx, {
      action: 'policy.update',
      targetType: 'policy',
      targetId: row.id,
      metadata: { name: row.name, effect: row.effect },
    });
    return toView(row);
  }

  const row = await ctx.db.policy.create({
    data: {
      orgId: ctx.activeOrgId,
      name: args.name,
      description: args.description ?? null,
      effect: args.effect,
      source: args.source,
      priority: args.priority ?? 0,
      enabled: args.enabled ?? true,
      isdefault: false,
      createdById: ctx.user.id,
    },
  });
  await writeAudit(ctx, {
    action: 'policy.create',
    targetType: 'policy',
    targetId: row.id,
    metadata: { name: row.name, effect: row.effect },
  });
  return toView(row);
}

export async function deletePolicy(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const row = await ctx.db.policy.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, isdefault: true },
  });
  if (!row) throw notFound('policy', id);
  if (row.isdefault) throw new Error('default policies cannot be deleted');
  await ctx.db.policy.delete({ where: { id } });
  await writeAudit(ctx, { action: 'policy.delete', targetType: 'policy', targetId: id });
  return { id, deleted: true };
}
