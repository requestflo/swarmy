import { networkIsolationViolations } from '@swarmy/core';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { evaluateAdmission, type AdmissionIntent, type Violation } from './admission.service';
import { writeAudit } from './audit.service';

/**
 * The shared "refuse / override / audit" wrapper every deploy-shaped mutation
 * uses around the admission spine (`evaluateAdmission`). It does NOT change the
 * spine's fan-out — it only applies the one set of decision semantics that
 * `deployFromCompose` established, so every deploy path behaves identically:
 *
 *  - interactive (a person or API key deploying):
 *      any violation + no override  → `admissionDenied` (PRECONDITION_FAILED,
 *                                     swarmyCode POLICY_DENIED); the guardrails
 *                                     evaluator records `guardrails.deploy.blocked`.
 *      block violation + override by a `member` → FORBIDDEN (admin/owner only).
 *      violations + permitted override → one `<kind>.override` audit row.
 *  - automation (workers/webhooks: autodeploy, PR previews): nobody can
 *      confirm a warn or authorise an override, so warns pass (they are still
 *      recorded by the evaluator) and any `block` refuses.
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
  const wall = networkIsolationViolations(intent.specs);
  if (wall.length) throw admissionDenied(wall.map((v) => ({ ...v, severity: 'block' as const })));

  const automation = opts.mode === 'automation';
  const effective: AdmissionIntent = automation ? { ...intent, override: false } : intent;
  const violations = await evaluateAdmission(ctx, effective);
  if (violations.length === 0) return violations;

  if (automation) {
    if (violations.some((v) => v.severity === 'block')) throw admissionDenied(violations);
    return violations;
  }

  if (!effective.override) throw admissionDenied(violations);
  const hasBlock = violations.some((v) => v.severity === 'block');
  if (hasBlock && ctx.membership?.role === 'member') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'overriding a blocking policy violation requires an admin or owner',
      cause: { swarmyCode: 'POLICY_DENIED', violations },
    });
  }
  await writeAudit(ctx, {
    action: intent.kind === 'stack.deploy' ? 'stack.deploy.override' : 'service.deploy.override',
    targetType: opts.targetType,
    targetId: opts.targetId,
    metadata: { violations: violations.map((v) => ({ ...v })) },
  });
  return violations;
}
