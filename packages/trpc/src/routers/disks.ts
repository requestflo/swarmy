import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure, resolveNode } from '../abac';
import {
  formatNodeDisk,
  growNodeDisk,
  listNodeDisks,
  repairNodeDisk,
  setDiskFormatAllowed,
} from '../services/disks.service';

/**
 * Add a disk (plans/epic-volume-mobility.md phase 1): list a server's disks,
 * format + mount a blank one, grow one the owner enlarged. Formatting is
 * `node.disk.format`-gated (owner/admin), typed-serial confirmed and audited.
 */
export const disksRouter = router({
  list: orgProcedure.input(z.object({ nodeId: z.string() })).query(({ ctx, input }) => listNodeDisks(ctx, input.nodeId)),

  format: abacProcedure('node.disk.format', (ctx, input) => resolveNode(ctx, { id: (input as { nodeId?: string })?.nodeId }))
    .input(
      z.object({
        nodeId: z.string(),
        path: z.string(),
        serial: z.string().min(4),
        sizeBytes: z.number().int().positive(),
        /** The last 4 characters of the disk serial, typed by the operator. */
        confirm: z.string().min(1).max(16),
      }),
    )
    .mutation(({ ctx, input }) => formatNodeDisk(ctx, input)),

  grow: adminProcedure
    .input(z.object({ nodeId: z.string(), serial: z.string().min(1) }))
    .mutation(({ ctx, input }) => growNodeDisk(ctx, input)),

  /**
   * Re-attach a disk swarmy formatted that is not mounted (QA-075b): stops
   * the apps on it, moves what was written to the root disk onto it (the
   * originals are kept), mounts it and starts the apps again. The
   * disk-reconcile worker does the same on its own; this is "do it now".
   */
  repair: adminProcedure
    .input(z.object({ nodeId: z.string(), serial: z.string().min(1) }))
    .mutation(({ ctx, input }) => repairNodeDisk(ctx, input)),

  /** Per-server opt-out of formatting (`swarmy.node.diskFormat`). */
  setFormatAllowed: adminProcedure
    .input(z.object({ nodeId: z.string(), allowed: z.boolean() }))
    .mutation(({ ctx, input }) => setDiskFormatAllowed(ctx, input)),
});
