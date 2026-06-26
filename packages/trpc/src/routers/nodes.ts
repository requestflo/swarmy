import { z } from 'zod';
import { orgProcedure, adminProcedure, router } from '../trpc';
import {
  getNode,
  listNodes,
  removeNode,
  setNodeAvailability,
  setNodeLabels,
} from '../services/node.service';
import {
  generateJoinToken,
  listJoinTokens,
  revokeJoinToken,
} from '../services/token.service';

export const nodesRouter = router({
  list: orgProcedure.query(({ ctx }) => listNodes(ctx)),

  get: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getNode(ctx, input.id)),

  containers: orgProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => ctx.hub.latestContainers(input.nodeId)),

  setLabels: orgProcedure
    .input(z.object({ id: z.string(), labels: z.record(z.string()) }))
    .mutation(({ ctx, input }) => setNodeLabels(ctx, input.id, input.labels)),

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
