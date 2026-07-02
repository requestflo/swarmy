import type { OrgContext } from '../context';
import { evaluate as evaluateExposure } from './admission-exposure';
import { evaluate as evaluateGuardrails } from './admission-guardrails';
import { evaluate as evaluateImages } from './admission-images';

/**
 * Admission pipeline (spine) — the single gate every deploy-shaped mutation
 * runs through before touching the swarm. Deploy paths build an
 * `AdmissionIntent`, call `evaluateAdmission`, and refuse when any `block`
 * violation is returned — unless `intent.override` is true (overrides are
 * audited by the caller).
 *
 * The three evaluators are owned by their slices (exposure E3, guardrails E4,
 * images D3); this file's shape is the spine contract and must not change.
 */

/** What a deploy-shaped mutation is about to do, for policy evaluation. */
export interface AdmissionIntent {
  kind: 'stack.deploy' | 'service.deploy' | 'db.topology' | 'exposure.change';
  orgId: string;
  stackName?: string;
  /** Service specs / compose-derived specs the intent would apply. */
  specs?: unknown[];
  meta?: Record<string, unknown>;
  /** True when the caller explicitly overrides `block` violations (audited). */
  override?: boolean;
}

/** One policy violation produced by an admission evaluator. */
export interface Violation {
  rule: string;
  severity: 'block' | 'warn';
  message: string;
  resource?: string;
}

/** Run every admission evaluator and concatenate their violations. */
export async function evaluateAdmission(
  ctx: OrgContext,
  intent: AdmissionIntent,
): Promise<Violation[]> {
  const results = await Promise.all([
    evaluateExposure(ctx, intent),
    evaluateGuardrails(ctx, intent),
    evaluateImages(ctx, intent),
  ]);
  return results.flat();
}
