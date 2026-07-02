import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';

/**
 * Exposure admission evaluator (slice E3) — enforces `ExposureConfig.rulesJson`
 * (forbid public ports on managed data services, forbid publicUdp, warn on new
 * published ports) against the intent's specs.
 *
 * Spine stub — returns no violations until E3 implements it.
 */
export async function evaluate(_ctx: OrgContext, _intent: AdmissionIntent): Promise<Violation[]> {
  return [];
}
