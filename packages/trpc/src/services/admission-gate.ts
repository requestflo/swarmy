import { networkIsolationViolations, reservedLabelViolations } from '@swarmy/core';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';
import { assessAdmission, recordAdmission } from './admission-record';

/**
 * The shared "refuse / override / audit" wrapper every deploy-shaped mutation
 * uses around the admission spine (`evaluateAdmission`). It does NOT change the
 * spine's fan-out — it only applies the one set of decision semantics that
 * `deployFromCompose` established, so every deploy path behaves identically:
 *
 *  - interactive (a person or API key deploying):
 *      any violation + no override  → `admissionDenied` (PRECONDITION_FAILED,
 *                                     swarmyCode POLICY_DENIED).
 *      block violation + override by a `member` → FORBIDDEN (admin/owner only).
 *      block override without a reason, when the caller requires one →
 *                                     BAD_REQUEST (OVERRIDE_REASON_REQUIRED).
 *      violations + permitted override → one `<kind>.override` audit row,
 *                                     carrying the reason when given.
 *  - automation (workers/webhooks: autodeploy, PR previews): nobody can
 *      confirm a warn or authorise an override, so warns pass and any `block`
 *      refuses.
 *
 * Every decision is recorded here, once (`recordAdmission`): blocked, warned,
 * overridden, or allowed with a Warn/Off guardrail that would have blocked.
 * The one exception is a block override missing its reason: that is an
 * unfinished form, not a decision, and the person sends it again.
 */

/** Admission refusal — a typed error listing every policy violation. */
export function admissionDenied(violations: Violation[]): TRPCError {
  const lines = violations.map(
    (v) => `[${v.severity}] ${v.rule}: ${v.message}${v.resource ? ` (${v.resource})` : ''}`,
  );
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `Deployment blocked by policy:\n${lines.join('\n')}`,
    cause: { swarmyCode: 'POLICY_DENIED', violations },
  });
}

export interface EnforceAdmissionOptions {
  /** Audit target for the override row (e.g. `service` / `stack`). */
  targetType: string;
  targetId: string;
  /** `automation` = system actor, no override possible, only `block` refuses. */
  mode?: 'interactive' | 'automation';
  /** Why the person is overriding; recorded on the override audit row. */
  overrideReason?: string;
  /** Refuse a `block` override that carries no reason (the dashboard's "Deploy anyway"). */
  requireReason?: boolean;
}

/**
 * Run the admission spine for `intent` and enforce the decision. Returns the
 * (possibly empty) violation list when the deploy may proceed; throws when it
 * must not.
 */
export async function enforceAdmission(
  ctx: OrgContext,
  intent: AdmissionIntent,
  opts: EnforceAdmissionOptions,
): Promise<Violation[]> {
  // The network wall is not a policy: no override (admin or not) lets an app
  // join the control-plane network or alias a name on the shared platform one.
  // Reserved labels ride the same wall: an app may not pose as a platform
  // service (`swarmy.system`) or as managed data it wasn't made into.
  const liveByName = new Map(ctx.hub?.liveInventory?.(ctx.activeOrgId)?.services.map((s) => [s.name, s.labels]) ?? []);
  const wall = [
    ...networkIsolationViolations(intent.specs),
    ...reservedLabelViolations(intent.specs, (name) => liveByName.get(name)),
  ];
  if (wall.length) throw admissionDenied(wall.map((v) => ({ ...v, severity: 'block' as const })));

  const automation = opts.mode === 'automation';
  const effective: AdmissionIntent = automation ? { ...intent, override: false } : intent;
  const assessed = await assessAdmission(ctx, effective);
  const { violations } = assessed;
  const record = (admitted: boolean, reason?: string): Promise<void> =>
    recordAdmission(ctx, {
      ...assessed,
      intent: effective,
      admitted,
      mode: automation ? 'automation' : 'interactive',
      targetType: opts.targetType,
      targetId: opts.targetId,
      ...(reason ? { reason } : {}),
    });
  const hasBlock = violations.some((v) => v.severity === 'block');

  if (violations.length === 0 || (automation && !hasBlock)) {
    await record(true);
    return violations;
  }
  if (automation || !effective.override) {
    await record(false);
    throw admissionDenied(violations);
  }
  if (hasBlock && ctx.membership?.role === 'member') {
    await record(false);
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'overriding a blocking policy violation requires an admin or owner',
      cause: { swarmyCode: 'POLICY_DENIED', violations },
    });
  }
  const reason = opts.overrideReason?.trim() || undefined;
  if (hasBlock && opts.requireReason && !reason) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'say why you are deploying past a blocking guardrail — the reason is audited',
      cause: { swarmyCode: 'OVERRIDE_REASON_REQUIRED', violations },
    });
  }
  await record(true, reason);
  return violations;
}
