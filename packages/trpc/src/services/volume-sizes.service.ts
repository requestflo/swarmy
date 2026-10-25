/**
 * Each server's volume sizes (boards 9 + 36), served from the hub's memory —
 * the agents measure Docker's `/system/df?type=volume` every 10 minutes and
 * send it on a `metrics` frame. No table, no history, no dispatch: a read is
 * never a command. A server whose agent predates the report answers
 * `sampledAt: null`, which the dashboard words as "size not reported".
 */
import type { NodeVolumeSizes } from '@swarmy/core';
import type { OrgContext } from '../context';

/** One row per server in the org, reported or not. */
export async function listVolumeSizes(ctx: OrgContext): Promise<NodeVolumeSizes[]> {
  const rows = (await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } })) as { id: string }[];
  return rows.map((r) => {
    const s = ctx.hub.volumeSizesFor?.(r.id);
    return {
      nodeId: r.id,
      sampledAt: s?.sampledAt ?? null,
      volumes: (s?.volumes ?? []).map((v) => ({ name: v.name, sizeBytes: v.sizeBytes })),
    };
  });
}
