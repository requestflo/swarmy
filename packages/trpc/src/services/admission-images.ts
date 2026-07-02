import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';

/**
 * Image-policy admission evaluator (slice D3) — enforces registry policy
 * (requireSignedImages via cosign verify, blockCriticalCves via `ImageScan`
 * lookups) against the images the intent would deploy.
 *
 * Spine stub — returns no violations until D3 implements it.
 */
export async function evaluate(_ctx: OrgContext, _intent: AdmissionIntent): Promise<Violation[]> {
  return [];
}
