import { SetExposureRulesInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { getRules, listViolations, overview, setRules } from '../services/exposure.service';

/**
 * Exposure (slice E3) — the public/private/managed audit of every service,
 * the org's exposure rules (`ExposureConfig`) and the live violations feed.
 * The audit is Docker-truth (live inventory); only the rule toggles persist.
 */
export const exposureRouter = router({
  /** The audit table: per-service verdict + counts (poll for live data). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Rule toggles + the enforce switch; seeds defaults on first read. */
  rules: orgProcedure.query(({ ctx }) => getRules(ctx)),

  /** Update rule toggles / "Block violating deploys" (partial; audited). */
  setRules: orgProcedure
    .input(SetExposureRulesInput)
    .mutation(({ ctx, input }) => setRules(ctx, input)),

  /** Current audit × current rules → violations with fix hints. */
  violations: orgProcedure.query(({ ctx }) => listViolations(ctx)),
});
