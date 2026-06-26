import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { getDeployStatus, watchDeployStatus } from '../services/deployment.service';

export const deploymentsRouter = router({
  get: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => getDeployStatus(ctx, input.id)),

  watch: orgProcedure
    .input(z.object({ id: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const ac = signal ?? new AbortController().signal;
      yield* watchDeployStatus(ctx, input.id, ac);
    }),
});
