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
    const row = await ctx.db.canvasLayout.findUnique({ where: { orgId: ctx.activeOrgId } });
    return {
      positions: (row?.positions as Record<string, { x: number; y: number }> | undefined) ?? {},
      viewport: (row?.viewport as { x: number; y: number; zoom: number } | null | undefined) ?? null,
    };
  }),

  /** Persist the whole position map (+ optional viewport). Debounced on the client. */
  save: orgProcedure
    .input(z.object({ positions: z.record(z.string(), Position), viewport: Viewport.nullish() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.canvasLayout.upsert({
        where: { orgId: ctx.activeOrgId },
        create: {
          orgId: ctx.activeOrgId,
          positions: input.positions,
          viewport: input.viewport ?? undefined,
        },
        update: { positions: input.positions, viewport: input.viewport ?? undefined },
      });
      return { ok: true as const };
    }),
});
