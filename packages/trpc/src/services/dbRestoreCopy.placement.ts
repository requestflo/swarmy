/**
 * Where a restore copy's primary goes: the same rules as any new managed
 * Postgres (`explainPinNode`: an added data disk first, then the server with
 * the fewest primaries, skipping a disk that is not attached), kept inside
 * the source's region when it has one: its declared write region, else the
 * region of the server it is pinned to. Undefined = no region to keep (or no
 * usable server in it), so the provision path makes its usual choice.
 */
import { DB_PIN_NODE_LABEL, explainPinNode, pinnedPrimaryCounts } from '@swarmy/core';
import type { OrgContext } from '../context';
import { unmountedDefaultDiskNodes } from './disks.service';
import { DB_PLACED_REGION_LABEL, DB_WRITE_REGION_LABEL, REGION_NODE_LABEL } from './manageddb.service';

export function copyPinNode(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>, sourceLabels: Record<string, string>): string | undefined {
  const nodes = ctx.hub.nodeInventory(ctx.activeOrgId);
  const pinned = nodes.find((n) => n.swarmNodeId === sourceLabels[DB_PIN_NODE_LABEL]);
  const region =
    sourceLabels[DB_PLACED_REGION_LABEL] || sourceLabels[DB_WRITE_REGION_LABEL] || pinned?.labels?.[REGION_NODE_LABEL];
  if (!region) return undefined;
  const inRegion = nodes.filter((n) => n.labels?.[REGION_NODE_LABEL] === region);
  if (inRegion.length === 0) return undefined;
  return explainPinNode({
    nodes: inRegion,
    pinnedCounts: pinnedPrimaryCounts(ctx.hub.liveInventory(ctx.activeOrgId).services),
    unmountedDefaultDisk: unmountedDefaultDiskNodes(ctx.hub, ctx.activeOrgId),
  }).node;
}
