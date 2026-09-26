import { z } from 'zod';
import { DeployId } from '@swarmy/core/protocol';
import { orgProcedure, router } from '../trpc';
import { getDeployEvents, subscribeDeployEvents } from '../services/deploy-trace.service';

/**
 * Traced deploys (the Deploying screen). A deploy id comes back from
 * `blueprints.deploy` / `stacks.deployFromCompose`; its events live in memory
 * for 30 min. Org-scoped like reading the app: another org's id is not found.
 */
export const deploysRouter = router({
  /** What is buffered so far (the replay a late page starts from). */
  get: orgProcedure
    .input(z.object({ deployId: DeployId }))
    .query(({ ctx, input }) => getDeployEvents(ctx, input.deployId)),
  /** Replay, then the live tail, ending when the deploy is live or given up on. */
  events: orgProcedure
    .input(z.object({ deployId: DeployId }))
    .subscription(async function* ({ ctx, input, signal }) {
      yield* subscribeDeployEvents(ctx, input.deployId, signal ?? new AbortController().signal);
    }),
});
