import { TRPCError } from '@trpc/server';
import { ENV_LABEL, PRODUCTION } from '@swarmy/abac';
import { buildInventory } from '@swarmy/core';
import { resolveStackByName, type ResolveResource } from './abac';

/**
 * Resolve a volume save from `{ snapshotId }` to the app it belongs to, so a
 * policy over an app's labels ("members may restore outside production")
 * reaches what is inside its backups. A volume is the app's when its name
 * starts with `<stack>_` (the longest live match wins, like retention). A save
 * no live app claims is judged as production: the read fails closed.
 */
export const resolveSnapshotStack: ResolveResource = async (ctx, input) => {
  const id = (input as { snapshotId?: unknown } | null)?.snapshotId;
  if (typeof id !== 'string' || !id) return null;
  const snap = await ctx.db.snapshot.findFirst({ where: { id, orgId: ctx.activeOrgId }, select: { volume: true } });
  if (!snap) throw new TRPCError({ code: 'NOT_FOUND', message: `snapshot ${id} not found` });
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const stack = [...new Set(buildInventory(services, containers).services.map((s) => s.stack).filter(Boolean))]
    .filter((name) => snap.volume.startsWith(`${name}_`))
    .sort((a, b) => b.length - a.length)[0];
  if (stack) return resolveStackByName(ctx, { stack });
  return { type: 'volume', id: snap.volume, orgId: ctx.activeOrgId, labels: { [ENV_LABEL]: PRODUCTION } };
};
