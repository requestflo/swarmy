import type { InvService } from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { consumersOf, liveOrgServices, type FamilyGroup } from './secretsMgr.service';

const DISPATCH_TIMEOUT_MS = 30_000;

/**
 * Remove every version of these families unless a service OUTSIDE `stack`
 * still mounts one (kept and reported) — the stack's own services are being
 * removed, so they don't count even while the inventory still lists them.
 * One `secrets.delete` row per family (`why` says on whose behalf): a stack
 * delete's blueprint families, a removed environment's own families.
 */
export async function removeFamiliesOfStack(
  ctx: OrgContext,
  nodeId: string,
  stack: string,
  groups: readonly FamilyGroup[],
  why: (g: FamilyGroup) => Record<string, unknown>,
): Promise<{ removed: string[]; kept: string[] }> {
  const others: InvService[] = liveOrgServices(ctx).filter((s) => s.stack !== stack);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const g of groups) {
    if (consumersOf(others, g).length) {
      kept.push(g.family);
      continue;
    }
    const removedVersions: number[] = [];
    for (const v of g.versions) {
      // A version the removed tasks still hold is released as they stop — a
      // failed remove leaves that version for the Secrets page, never aborts.
      const ok = await ctx.hub
        .dispatch(nodeId, 'secret.remove', { name: v.name }, { timeoutMs: DISPATCH_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      if (ok) removedVersions.push(v.version);
    }
    if (removedVersions.length) removed.push(g.family);
    await writeAudit(ctx, {
      action: 'secrets.delete',
      targetType: 'secretFamily',
      targetId: g.family,
      metadata: {
        ...why(g),
        stack,
        removedVersions: removedVersions.sort((a, b) => a - b),
        ...(removedVersions.length < g.versions.length ? { failedVersions: g.versions.length - removedVersions.length } : {}),
      },
    });
  }
  return { removed, kept };
}
