import { z } from 'zod';
import { NODE_PROFILE_VALUES } from '@swarmy/core';
import { orgProcedure, adminProcedure, router } from '../trpc';
import { abacProcedure, resolveNode } from '../abac';
import { listRecoveryClaims, resolveRecoveryClaim } from '../services/recovery.service';
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
  upgradeAgent,
} from '../services/node.service';
import { agentRelease } from '../services/agent-release.service';
import {
  generateJoinToken,
  listJoinTokens,
  revokeJoinToken,
} from '../services/token.service';
import { setNodeCost } from '../services/cost.service';
import { listNodeHygiene, runNodeHygieneNow } from '../services/node-hygiene.service';

export const nodesRouter = router({
  list: orgProcedure.query(({ ctx }) => listNodes(ctx)),

  // Recovery beacon (self-healing epic): pending device-pairing-style claims
  // from nodes that lost every credential; approve after comparing the
  // fingerprint the machine printed in its journal.
  recoveryClaims: orgProcedure.query(({ ctx }) => listRecoveryClaims(ctx)),
  resolveRecoveryClaim: adminProcedure
    .input(z.object({ id: z.string(), approve: z.boolean() }))
    .mutation(({ ctx, input }) => resolveRecoveryClaim(ctx, input)),

  get: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getNode(ctx, input.id)),

  containers: orgProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => ctx.hub.latestContainers(input.nodeId)),

  setLabels: orgProcedure
    .input(z.object({ id: z.string(), labels: z.record(z.string()) }))
    .mutation(({ ctx, input }) => setNodeLabels(ctx, input.id, input.labels)),

  /** Toggle ingress/outlet/storage/database/builder roles (Docker node labels). Partial — omit a role to leave it. */
  setRole: adminProcedure
    .input(
      z.object({
        id: z.string(),
        ingress: z.boolean().optional(),
        outlet: z.boolean().optional(),
        storage: z.boolean().optional(),
        database: z.boolean().optional(),
        /** CI builder capability (`swarmy.node.builder`) — builds + image GC run here. */
        builder: z.boolean().optional(),
        /** Container exec (`swarmy.node.exec`) — default on. Audited. */
        exec: z.boolean().optional(),
        /** Host shell (`swarmy.node.shell`) — default off; grants root on the host. Audited. */
        shell: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setNodeRole(ctx, input.id, {
        ingress: input.ingress,
        outlet: input.outlet,
        storage: input.storage,
        database: input.database,
        builder: input.builder,
        exec: input.exec,
        shell: input.shell,
      }),
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

  drain: abacProcedure('node.drain', resolveNode)
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => setNodeAvailability(ctx, input.id, 'drain')),

  activate: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => setNodeAvailability(ctx, input.id, 'active')),

  remove: abacProcedure('node.remove', resolveNode).input(z.object({ id: z.string() })).mutation(({ ctx, input }) =>
    removeNode(ctx, input.id),
  ),

  /** Disk hygiene: effective settings (node labels) + recent cleanup runs for the node's activity. */
  hygiene: orgProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => listNodeHygiene(ctx, input.nodeId)),

  /** "Clean up now": prune stopped one-shots, unused images (never an in-prod digest) and build cache. */
  runHygiene: abacProcedure('data.destroy')
    .input(z.object({ nodeId: z.string(), dryRun: z.boolean().optional() }))
    .mutation(({ ctx, input }) => runNodeHygieneNow(ctx, input)),

  /** The agent release this controller can hand out (version + platforms), or null when no binaries are built. */
  agentRelease: orgProcedure.query(() => {
    const release = agentRelease();
    return release
      ? { version: release.version, commit: release.commit ?? null, platforms: Object.keys(release.platforms) }
      : null;
  }),

  /** Push this controller's agent release to a node (self-replace or docker-recreate by packaging). */
  upgradeAgent: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => upgradeAgent(ctx, input.id)),

  generateJoinToken: adminProcedure
    .input(
      z.object({
        ttlSeconds: z.number().int().min(60).max(604_800).optional(),
        maxUses: z.number().int().min(1).max(100).optional(),
        label: z.string().max(80).optional(),
        /** WS7 install profile: the label bundle nodes enroll with. */
        profile: z.enum(NODE_PROFILE_VALUES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => generateJoinToken(ctx, input)),

  listJoinTokens: orgProcedure.query(({ ctx }) => listJoinTokens(ctx)),

  revokeJoinToken: abacProcedure('token.revoke')
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
