import { BlueprintDeployInput, BlueprintPlanInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { deployBlueprint, listBlueprints, planBlueprint } from '../services/blueprints.service';

/**
 * Blueprints (slice F3) — the parameterized app catalog: gallery, dry-run plan
 * preview and sequential deploy through existing services (managed DB/cache,
 * buckets, secrets, stack compose, ingress routes).
 */
export const blueprintsRouter = router({
  /** The static gallery (cards, taglines, per-blueprint option descriptors). */
  list: orgProcedure.query(({ ctx }) => listBlueprints(ctx)),

  /** Dry-run: the exact steps a deploy would execute, display-safe. */
  plan: orgProcedure.input(BlueprintPlanInput).query(({ ctx, input }) => planBlueprint(ctx, input)),

  /** Execute the plan sequentially; per-step results return synchronously. */
  deploy: orgProcedure
    .input(BlueprintDeployInput)
    .mutation(({ ctx, input }) => deployBlueprint(ctx, input)),
});
