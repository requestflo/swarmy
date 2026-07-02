import type { OrgContext } from '../context';

/**
 * Incident recording helper (slice C4) — appends an event to the open incident
 * for `groupKey` (opening one if needed) so automation (alert-evaluator, A2
 * failover promotion, deploy safety) can build the incident timeline without
 * owning incident lifecycle logic.
 *
 * Spine stub — a no-op until C4 implements it; callers compile now.
 */

/** Record one incident event under a correlation group key. */
export async function recordIncidentEvent(
  _ctx: OrgContext,
  _input: {
    groupKey: string;
    kind: string;
    message: string;
    severity?: 'warning' | 'critical';
    meta?: Record<string, unknown>;
  },
): Promise<void> {}
