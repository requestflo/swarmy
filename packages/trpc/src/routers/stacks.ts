import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import {
  deployFromCompose,
  getStack,
  listStacks,
  redeployStack,
  removeStack,
} from '../services/stack.service';

export const stacksRouter = router({
  list: orgProcedure.query(({ ctx }) => listStacks(ctx)),

  get: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getStack(ctx, input.id)),

  deployFromCompose: orgProcedure
    .input(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
        composeSource: z.string().min(1).max(256_000),
      }),
    )
    .mutation(({ ctx, input }) => deployFromCompose(ctx, input)),

  redeploy: orgProcedure
    .input(z.object({ id: z.string(), composeSource: z.string().optional() }))
    .mutation(({ ctx, input }) => redeployStack(ctx, input)),

  remove: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeStack(ctx, input.id)),
});
