import { z } from 'zod';
import { orgProcedure, adminProcedure, router } from '../trpc';
import { abacProcedure, resolveNode, resolveService, type ResolveResource } from '../abac';
import { commandRejected } from '../errors';
import {
  decommissionStatus,
  oldCopiesOnNode,
  planNodeDecommission,
  startDecommission,
  stopDecommission,
} from '../services/decommission.service';
import { deleteOldCopy, moveServiceData, planServiceMove } from '../services/volumeMove.service';
import { checkUndoMove, runUndoMove } from '../services/volumeMove.undo';

/**
 * Volume mobility (plans/epic-volume-mobility.md): retire a server, move one
 * service's data, and the old copies a move keeps. Retiring is `node.remove`-
 * gated (the same bar as removing a server); deleting an old copy is
 * `data.destroy` on the service it belonged to (its live labels, so a
 * production rule applies). Both are audited in the service layer.
 */

/** The service an old copy belongs to (`{ service }`), resolved live like `resolveService`. */
const resolveCopyService: ResolveResource = (ctx, input) => {
  const service = (input as { service?: unknown } | null | undefined)?.service;
  return typeof service === 'string' && service ? resolveService(ctx, { id: service }) : null;
};
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

  /** Delete an old copy — only ever on an explicit owner request. `data.destroy`, owner/admin by default. */
  deleteOldCopy: abacProcedure('data.destroy', resolveCopyService)
    .input(z.object({ service: z.string(), nodeId: z.string(), volume: z.string() }))
    .mutation(({ ctx, input }) => deleteOldCopy(ctx, input)),

  /**
   * Move one service's data to another server (two-pass copy, short pause).
   * Refusals (multi-copy, managed primary, offline destination…) are checked
   * first and returned as errors; the move itself then runs in the background.
   * Progress is the service's `swarmy.move.state` label in the live inventory,
   * the outcome an audit row.
   */
  moveService: adminProcedure
    .input(z.object({ service: z.string(), toNodeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const plan = await planServiceMove(ctx, input);
      void moveServiceData(ctx, input).catch(() => undefined); // failures roll back + audit inside
      // `warnings`: e.g. a volume size nobody reported, so the disk fit went unchecked.
      return { started: true, service: input.service, warnings: plan.warnings };
    }),

  /**
   * Undo the newest move within 24 hours: back onto the old copy it kept, no
   * copying. Gated and audited like the move. Both copies are checked against
   * the move's snapshot point first (awaited, so a refusal such as "Writes
   * happened on wkr-2 since the move" reaches the person); the stop, the
   * re-check and the re-pin then run in the background on `swarmy.move.state`.
   */
  undoMove: adminProcedure
    .input(z.object({ service: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const plan = await checkUndoMove(ctx, input);
      void runUndoMove(ctx, plan).catch(() => undefined); // failures roll back + audit inside
      return { started: true, service: input.service, from: plan.dest.nodeId, to: plan.source.nodeId };
    }),
});
