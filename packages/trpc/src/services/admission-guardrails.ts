import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';

/**
 * Guardrails admission evaluator (slice E4) — enforces `GuardrailConfig.rulesJson`
 * (noLatestTagInProd, minDbReplicas, requireBackupPolicy, requireHealthcheck,
 * requireResourceLimits, productionSafetyMode) against the intent's specs.
 *
 * Spine stub — returns no violations until E4 implements it.
 */
export async function evaluate(_ctx: OrgContext, _intent: AdmissionIntent): Promise<Violation[]> {
  return [];
}
