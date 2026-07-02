import {
  GuardrailDecisionsInput,
  SetGuardrailRuleInput,
  SetGuardrailSafetyModeInput,
  SetStackEnvInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  getConfig,
  listStackEnvs,
  recentDecisions,
  setRule,
  setSafetyMode,
  setStackEnv,
} from '../services/guardrails.service';

/**
 * Guardrails (slice E4) — production safety rules enforced at deploy admission.
 * Config (rule toggles + the safety-mode master switch) lives in the one-per-org
 * `GuardrailConfig` row; "this stack is production" is Docker truth (the
 * `swarmy.env` label); the decisions feed is an AuditLog query.
 */
export const guardrailsRouter = router({
  /** Rule list + the production-safety master switch; seeds defaults on first read. */
  config: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  /** Flip production safety mode: every rule blocks on production stacks (audited). */
  setSafetyMode: orgProcedure
    .input(SetGuardrailSafetyModeInput)
    .mutation(({ ctx, input }) => setSafetyMode(ctx, input)),

  /** Update one rule's enabled/severity/params (partial; audited). */
  setRule: orgProcedure.input(SetGuardrailRuleInput).mutation(({ ctx, input }) => setRule(ctx, input)),

  /** Every live stack + its environment marking (poll for live data). */
  stackEnvs: orgProcedure.query(({ ctx }) => listStackEnvs(ctx)),

  /** Mark/unmark a stack as production — writes the `swarmy.env` label (audited). */
  setStackEnv: orgProcedure
    .input(SetStackEnvInput)
    .mutation(({ ctx, input }) => setStackEnv(ctx, input)),

  /** Recent blocked/overridden admission decisions (audit-log backed). */
  recentDecisions: orgProcedure
    .input(GuardrailDecisionsInput)
    .query(({ ctx, input }) => recentDecisions(ctx, input)),
});
