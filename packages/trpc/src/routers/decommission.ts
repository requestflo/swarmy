import { z } from 'zod';
import { orgProcedure, adminProcedure, router } from '../trpc';
import { abacProcedure, resolveNode } from '../abac';
import { commandRejected } from '../errors';
import {
  decommissionStatus,
  oldCopiesOnNode,
  planNodeDecommission,
  startDecommission,
  stopDecommission,
} from '../services/decommission.service';
import { deleteOldCopy, moveServiceData } from '../services/volumeMove.service';

/**
 * Volume mobility (plans/epic-volume-mobility.md): retire a server, move one
 * service's data, and the old copies a move keeps. Retiring and deleting are
 * `node.remove`-gated (the same bar as removing a server) and audited in the
 * service layer.
 */
export const decommissionRouter = router({
  /** The drain plan for a server: steps, blockers, warnings, one-sentence summary. */
  plan: abacProcedure('node.remove', resolveNode)
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => planNodeDecommission(ctx, input.id)),

  /** The org's retire run (one server at a time), or null. */
  status: orgProcedure
    .input(z.object({ id: z.string().optional() }))
    .query(({ ctx, input }) => decommissionStatus(ctx, input.id)),

  /** Start (or resume) retiring a server. Runs in the background; poll `status`. */
  start: abacProcedure('node.remove', resolveNode)
    .input(z.object({ id: z.string(), confirmHostname: z.string(), acceptWarnings: z.boolean() }))
    .mutation(({ ctx, input }) => startDecommission(ctx, input)),

  /** Stop after the step in flight finishes. */
  stop: abacProcedure('node.remove', resolveNode)
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => stopDecommission(ctx, input.id)),

  /** Old copies kept on this server after moves (`due` = the 7 days are up). */
  oldCopies: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => oldCopiesOnNode(ctx, input.id)),

  /** Delete an old copy — only ever on an explicit owner request. */
  deleteOldCopy: adminProcedure
    .input(z.object({ service: z.string(), nodeId: z.string(), volume: z.string() }))
    .mutation(({ ctx, input }) => deleteOldCopy(ctx, input)),

  /**
   * Move one service's data to another server (two-pass copy, short pause).
   * Starts in the background; progress is the service's `swarmy.move.state`
   * label in the live inventory, the outcome an audit row.
   */
  moveService: adminProcedure
    .input(z.object({ service: z.string(), toNodeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === input.service);
      if (!svc) throw commandRejected(`no service named ${input.service}`);
      void moveServiceData(ctx, input).catch(() => undefined); // failures roll back + audit inside
      return { started: true, service: input.service };
    }),
});
