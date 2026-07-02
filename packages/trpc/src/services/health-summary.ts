import type { OrgContext } from '../context';

/**
 * Health narrative (slice C2) — composes a per-stack / per-service
 * `{ status, reasons[] }` summary from live inventory, service status, RED
 * metrics, `swarmy.db.lag.*` labels, queue stats, and collector/store state.
 * Consumed by stacks, status pages, alerts, and deploy safety.
 *
 * Spine stub — inert `unknown` results until C2 implements it; the signatures
 * are the spine contract and must not change.
 */

export interface HealthSummary {
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  reasons: string[];
}

/** Summarize the health of one stack (by stack namespace name). */
export async function summarizeStack(_ctx: OrgContext, _stackName: string): Promise<HealthSummary> {
  return { status: 'unknown', reasons: [] };
}

/** Summarize the health of one service (by id or name). */
export async function summarizeService(
  _ctx: OrgContext,
  _serviceRef: string,
): Promise<HealthSummary> {
  return { status: 'unknown', reasons: [] };
}
