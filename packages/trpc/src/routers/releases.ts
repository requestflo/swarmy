import { z } from 'zod';
import {
  CanaryRefInput,
  CanaryStatusInput,
  GetDeploySafetyInput,
  ReleaseListInput,
  RollbackReleaseInput,
  SetDeploySafetyInput,
  StartCanaryInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  abortCanary,
  canaryStatus,
  getRelease,
  getSafety,
  listReleases,
  overview,
  promoteCanary,
  rollbackTo,
  setSafety,
  startCanary,
} from '../services/releases.service';

/**
 * Releases & deploy safety (slice D1) — release history, health-gated deploys,
 * rollback, and the per-stack deploy-safety settings (Docker labels).
 */
export const releasesRouter = router({
  /** Counts for the releases hero — org-wide, or one stack's slice. */
  overview: orgProcedure
    .input(z.object({ stackName: z.string().optional() }).optional())
    .query(({ ctx, input }) => overview(ctx, input?.stackName)),

  /** Org-wide recent deploys, or one stack's history via `stackName`. */
  list: orgProcedure.input(ReleaseListInput).query(({ ctx, input }) => listReleases(ctx, input)),

  /** One release + its compose diff against the previous deploy. */
  get: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => getRelease(ctx, input.id)),

  /** Redeploy a past release's compose as a new release (audited). */
  rollback: orgProcedure
    .input(RollbackReleaseInput)
    .mutation(({ ctx, input }) => rollbackTo(ctx, input)),

  /** Health-gate + strategy settings read from the stack's Docker labels. */
  getSafety: orgProcedure
    .input(GetDeploySafetyInput)
    .query(({ ctx, input }) => getSafety(ctx, input.stackName)),

  /** Write (or clear) the `swarmy.deploy.safety` stack label (audited). */
  setSafety: orgProcedure
    .input(SetDeploySafetyInput)
    .mutation(({ ctx, input }) => setSafety(ctx, input)),

  // ── canary (D2) — weighted rollouts, label-driven, Docker truth ────────────

  /** In-flight canaries (labels + live RED metrics), org-wide or one stack's. */
  canaryStatus: orgProcedure
    .input(CanaryStatusInput)
    .query(({ ctx, input }) => canaryStatus(ctx, input)),

  /** Deploy `<svc>--canary` + shift trafficPct of its routes to it (audited). */
  startCanary: orgProcedure
    .input(StartCanaryInput)
    .mutation(({ ctx, input }) => startCanary(ctx, input)),

  /** Swap the stable service onto the canary image + retire the canary (audited). */
  promote: orgProcedure
    .input(CanaryRefInput)
    .mutation(({ ctx, input }) => promoteCanary(ctx, input)),

  /** Restore 100% stable traffic + remove the canary, untouched stable (audited). */
  abort: orgProcedure
    .input(CanaryRefInput)
    .mutation(({ ctx, input }) => abortCanary(ctx, input)),
});
