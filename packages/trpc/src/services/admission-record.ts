import { admissionRecord, type AdmissionMode, type WouldBlockHit } from '@swarmy/core';
import type { OrgContext } from '../context';
import { evaluateAdmission, type AdmissionIntent, type Violation } from './admission.service';
import { wouldBlock } from './admission-guardrails-shadow';
import { writeAudit } from './audit.service';

/**
 * Admission receipts, the controller half: run the spine plus the "would it
 * block?" pass, then record the decision through the one audit writer. The
 * row shape and its actions are `@swarmy/core` `admissionRecord`, so the
 * dashboard counts exactly what was written.
 *
 * Every admission run that has something to say writes one row: a refusal
 * from any evaluator (guardrails, image scan and signature, exposure), a
 * warning, an override, or a clean pass that a Warn or Off guardrail would
 * have refused at Block. A clean pass with nothing to imagine writes nothing.
 */

export interface AdmissionAssessment {
  violations: Violation[];
  /** Warn and Off guardrails that would have refused this run at Block. */
  wouldBlock: WouldBlockHit[];
}

/** The spine's decision plus the would-block pass, over one shared set of facts. */
export async function assessAdmission(ctx: OrgContext, intent: AdmissionIntent): Promise<AdmissionAssessment> {
  const [violations, hits] = await Promise.all([
    evaluateAdmission(ctx, intent),
    // A what-if never refuses (or breaks) a deploy.
    wouldBlock(ctx, intent).catch((): WouldBlockHit[] => []),
  ]);
  return { violations, wouldBlock: hits };
}

export interface RecordAdmissionInput extends AdmissionAssessment {
  intent: AdmissionIntent;
  /** The deploy goes on to the swarm. */
  admitted: boolean;
  mode: AdmissionMode;
  /** The override row's target (the service or stack being deployed). */
  targetType: string;
  targetId: string;
  reason?: string;
}

/** Write the run's receipt (best-effort, like every audit row). */
export async function recordAdmission(ctx: OrgContext, input: RecordAdmissionInput): Promise<void> {
  const row = admissionRecord({
    kind: input.intent.kind,
    ...(input.intent.stackName ? { stackName: input.intent.stackName } : {}),
    mode: input.mode,
    violations: input.violations,
    wouldBlock: input.wouldBlock,
    admitted: input.admitted,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (!row) return;
  // Overrides keep their target (the thing deployed); the other receipts name
  // the app, as the decisions feed always has.
  const byStack = !row.action.endsWith('.override') && !!input.intent.stackName;
  await writeAudit(ctx, {
    action: row.action,
    targetType: byStack ? 'stack' : input.targetType,
    targetId: byStack ? input.intent.stackName : input.targetId,
    ...(ctx.user ? {} : { actorType: 'system' as const }),
    metadata: { ...row.metadata },
  });
}
