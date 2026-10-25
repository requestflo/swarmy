/**
 * The stack an id from `listStacks` names. The list hands out a config row's
 * id, or — for a LABEL-ONLY stack (live services grouped under one
 * `com.docker.stack.namespace` with no row, e.g. a managed database's stack)
 * — its name. Removal (tRPC `stacks.remove`, REST `DELETE /stacks/{id}`) and
 * its policy gate (`resolveStack`) resolve ids through here, so they find
 * exactly the set the list shows: a name that has a row is listed by its row
 * id, so it isn't resolved by name.
 */
import { buildInventory, UNGROUPED } from '@swarmy/core';
import type { OrgContext } from '../context';
import { stacks } from './apps.repo';

export interface ListedStack {
  /** What the list hands out: the row id, or the name of a label-only stack. */
  id: string;
  name: string;
  /** The stored compose (null for a label-only stack). */
  composeSource: string | null;
  /** True: no config row, only live services. */
  labelOnly: boolean;
}

/** Does any live service of the org belong to `name` (the list's grouping)? */
function hasLiveServices(ctx: OrgContext, name: string): boolean {
  if (name === UNGROUPED) return false;
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.some((s) => s.stack === name);
}

export async function findListedStack(ctx: OrgContext, id: string): Promise<ListedStack | null> {
  const repo = stacks(ctx, ctx.activeOrgId);
  const row = await repo.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, composeSource: true },
  });
  if (row) return { id: row.id, name: row.name, composeSource: row.composeSource ?? null, labelOnly: false };
  if (!hasLiveServices(ctx, id)) return null;
  const named = await repo.findFirst({ where: { name: id, orgId: ctx.activeOrgId }, select: { id: true } });
  return named ? null : { id, name: id, composeSource: null, labelOnly: true };
}
