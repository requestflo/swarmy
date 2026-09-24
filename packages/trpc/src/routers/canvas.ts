import { canvasLayouts } from '../services/apps.repo';
import { z } from 'zod';
import { router, orgProcedure } from '../trpc';

/**
 * Applications-canvas layout persistence (redesign).
 *
 * The canvas is a *visual* arrangement of services/stacks — dragging a card never
 * changes where containers run, it only re-positions the diagram. Those positions
 * (and the last viewport) are stored per-org so the canvas reopens exactly as the
 * user left it, on any device. One row per org (`CanvasLayout`).
 */

const Position = z.object({ x: z.number(), y: z.number() });
const Viewport = z.object({ x: z.number(), y: z.number(), zoom: z.number() });

export const canvasRouter = router({
  /** Saved node positions + viewport for the active org's canvas. */
  get: orgProcedure.query(async ({ ctx }) => {
    const row = await canvasLayouts(ctx, ctx.activeOrgId).findUnique({ where: { orgId: ctx.activeOrgId } });
    return {
      positions: row?.positions ?? {},
      viewport: null as { x: number; y: number; zoom: number } | null,
    };
  }),

  /** Persist the whole position map (+ optional viewport). Debounced on the client. */
  save: orgProcedure
    .input(z.object({ positions: z.record(z.string(), Position), viewport: Viewport.nullish() }))
    .mutation(async ({ ctx, input }) => {
      // Unchanged positions write nothing (swarm-kv skips identical content).
      await canvasLayouts(ctx, ctx.activeOrgId).upsert({
        where: { orgId: ctx.activeOrgId },
        create: { positions: input.positions },
        update: { positions: input.positions },
      });
      return { ok: true as const };
    }),
});
