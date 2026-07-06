import { z } from 'zod';
import { EXPOSE_MODES, SetExposureRulesInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  getRules,
  listViolations,
  overview,
  setExposeMode,
  setRules,
} from '../services/exposure.service';

/**
 * Exposure (slice E3 + WS3) — the public/private/managed audit of every service,
 * the org's exposure rules (`ExposureConfig`), the live violations feed, and the
 * per-service DECLARED mode (`swarmy.expose` label, Docker truth).
 * The audit is Docker-truth (live inventory); only the rule toggles persist.
 */

/** `SetExposureRulesInput` + the WS3 declared-intent toggle (additive key). */
const SetRulesWithIntentInput = SetExposureRulesInput.extend({
  enforceDeclaredIntent: z.boolean().optional(),
});

export const exposureRouter = router({
  /** The audit table: per-service verdict + declared mode + drift (poll for live data). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Rule toggles + the enforce switch; seeds defaults on first read. */
  rules: orgProcedure.query(({ ctx }) => getRules(ctx)),

  /** Update rule toggles / "Block violating deploys" (partial; audited). */
  setRules: orgProcedure
    .input(SetRulesWithIntentInput)
    .mutation(({ ctx, input }) => setRules(ctx, input)),

  /** Declare (or clear, with `mode: null`) a service's exposure intent. */
  setMode: orgProcedure
    .input(z.object({ id: z.string().min(1), mode: z.enum(EXPOSE_MODES).nullable() }))
    .mutation(({ ctx, input }) => setExposeMode(ctx, input)),

  /** Current audit × current rules → violations with fix hints. */
  violations: orgProcedure.query(({ ctx }) => listViolations(ctx)),
});
