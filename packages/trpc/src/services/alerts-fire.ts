import type { OrgContext } from '../context';

/**
 * Alert firing helper (slice C3) — the one entry point other slices use to
 * raise an alert event (dedupe by rule+resource and for-duration handling live
 * here, not in callers). Used by jobs (B2), exposure audit (E3), db failover
 * (A2), deploy safety (D1), and the alert-evaluator worker.
 *
 * Spine stub — a no-op until C3 implements it; callers compile now.
 */

export interface FireEventInput {
  signal: string;
  severity: 'info' | 'warning' | 'critical';
  resource: string;
  message: string;
  ruleId?: string;
}

/** Raise (or dedupe into) an alert event and notify its channels. */
export async function fireEvent(_ctx: OrgContext, _input: FireEventInput): Promise<void> {}
