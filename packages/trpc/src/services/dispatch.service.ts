import type { OrgContext } from '../context';
import { noManager, nodeOffline, notFound } from '../errors';

/** Resolve a connected swarm-manager node (Docker truth) to route commands to. */
export async function resolveManagerNode(
  ctx: OrgContext,
  preferredNodeId?: string | null,
): Promise<{ id: string }> {
  if (preferredNodeId && ctx.hub.isOnline(preferredNodeId)) return { id: preferredNodeId };
  const managerId = ctx.hub.managerNode(ctx.activeOrgId);
  if (managerId) return { id: managerId };
  throw noManager();
}

/** Ensure a node exists in the org and is currently connected. */
export async function requireOnlineNode(ctx: OrgContext, nodeId: string): Promise<{ id: string }> {
  const node = await ctx.db.node.findFirst({
    where: { id: nodeId, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', nodeId);
  if (!ctx.hub.isOnline(node.id)) throw nodeOffline(node.id);
  return node;
}

export async function failDeployment(ctx: OrgContext, deploymentId: string, e: unknown): Promise<void> {
  await ctx.db.deployment.update({
    where: { id: deploymentId },
    data: { phase: 'FAILED', message: e instanceof Error ? e.message : String(e), finishedAt: new Date() },
  });
}
