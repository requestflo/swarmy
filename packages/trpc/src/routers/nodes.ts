import { z } from 'zod';
import { orgProcedure, adminProcedure, router } from '../trpc';
import {
  getNode,
  listNodeCanvasPositions,
  listNodeContainerCounts,
  listNodes,
  removeNode,
  setNodeAvailability,
  setNodeCanvasPosition,
  setNodeLabels,
  setNodeRegion,
  setNodeRole,
  setPublicIpOverride,
} from '../services/node.service';
import {
  generateJoinToken,
  listJoinTokens,
  revokeJoinToken,
} from '../services/token.service';
import { setNodeCost } from '../services/cost.service';

export const nodesRouter = router({
  list: orgProcedure.query(({ ctx }) => listNodes(ctx)),

  get: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getNode(ctx, input.id)),

  containers: orgProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => ctx.hub.latestContainers(input.nodeId)),

  setLabels: orgProcedure
    .input(z.object({ id: z.string(), labels: z.record(z.string()) }))
    .mutation(({ ctx, input }) => setNodeLabels(ctx, input.id, input.labels)),

  /** Toggle ingress/outlet roles (Docker node labels). Partial — omit a role to leave it. */
  setRole: adminProcedure
    .input(
      z.object({
        id: z.string(),
        ingress: z.boolean().optional(),
        outlet: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setNodeRole(ctx, input.id, { ingress: input.ingress, outlet: input.outlet }),
    ),

  /** Assign a node's region (`swarmy.region` label via updateSwarmNode). */
  setRegion: adminProcedure
    .input(z.object({ id: z.string(), region: z.string().min(1) }))
    .mutation(({ ctx, input }) => setNodeRegion(ctx, input.id, input.region)),

  /**
   * Manually override a node's public IP (`swarmy.node.public-ip.override`
   * label — beats the agent-detected value in DNS answers). Null clears.
   */
  setPublicIpOverride: adminProcedure
    .input(z.object({ id: z.string(), ip: z.string().ip({ version: 'v4' }).nullable() }))
    .mutation(({ ctx, input }) => setPublicIpOverride(ctx, input.id, input.ip)),

  /** Set (or clear) a node's monthly price — the `swarmy.node.cost` label (mirrors cost.setNodeCost). */
  setCost: adminProcedure
    .input(z.object({ id: z.string(), monthlyUsd: z.number().min(0).max(1_000_000).nullable() }))
    .mutation(({ ctx, input }) => setNodeCost(ctx, { nodeId: input.id, monthlyUsd: input.monthlyUsd })),

  /** Saved Infrastructure-canvas positions per node (`swarmy.canvas.x/y` labels). */
  canvasPositions: orgProcedure.query(({ ctx }) => listNodeCanvasPositions(ctx)),

  /** Container count per node (for the index list row) — same source as node.containers. */
  containerCounts: orgProcedure.query(({ ctx }) => listNodeContainerCounts(ctx)),

  /** Persist a node's canvas position as Docker node labels (mirrors services.setCanvasPos). */
  setCanvasPosition: orgProcedure
    .input(z.object({ id: z.string(), x: z.number(), y: z.number() }))
    .mutation(({ ctx, input }) => setNodeCanvasPosition(ctx, input)),

  drain: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => setNodeAvailability(ctx, input.id, 'drain')),

  activate: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => setNodeAvailability(ctx, input.id, 'active')),

  remove: adminProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) =>
    removeNode(ctx, input.id),
  ),

  generateJoinToken: adminProcedure
    .input(
      z.object({
        ttlSeconds: z.number().int().min(60).max(604_800).optional(),
        maxUses: z.number().int().min(1).max(100).optional(),
        label: z.string().max(80).optional(),
      }),
    )
    .mutation(({ ctx, input }) => generateJoinToken(ctx, input)),

  listJoinTokens: orgProcedure.query(({ ctx }) => listJoinTokens(ctx)),

  revokeJoinToken: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => revokeJoinToken(ctx, input.id)),

  liveStatsLatest: orgProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => ctx.hub.latestNodeStats(input.nodeId) ?? null),

  liveStats: orgProcedure
    .input(z.object({ nodeId: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const ac = signal ?? new AbortController().signal;
      for await (const frame of ctx.hub.subscribeNodeStats(input.nodeId, ac)) {
        yield frame;
      }
    }),
});
