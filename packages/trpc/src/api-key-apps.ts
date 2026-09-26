/**
 * Which app (stack name) a request's target belongs to — the lookups the REST
 * app gate uses to hold an app-scoped API key to its apps (owner decision Q7).
 * Pure over the org's own data: the kv stack rows and the live hub inventory.
 */
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from './context';
import { stacks } from './services/apps.repo';

const UNGROUPED = '(ungrouped)';

/**
 * A stack path id → its name. Stack ids are the config-row id, or the stack
 * name for label-only stacks (what `listStacks` hands out), so an id that is
 * not a row id is taken as the name.
 */
export async function stackNameForId(ctx: OrgContext, id: string): Promise<string> {
  const row = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { name: true },
  });
  return row?.name ?? id;
}

/** A live service (Docker id or name) → its stack name; null when ungrouped or unknown. */
export function serviceStackName(ctx: OrgContext, idOrName: string): string | null {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const svc = buildInventory(services, containers).services.find((s) => s.id === idOrName || s.name === idOrName);
  if (!svc || svc.stack === UNGROUPED) return null;
  return svc.stack;
}
