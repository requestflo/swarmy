import {
  ADMISSION_ACTION_LIST,
  tallyAdmission,
  type AdmissionTallyInput,
  type AdmissionTallyView,
} from '@swarmy/core';
import type { OrgContext } from '../context';

/**
 * Admission receipts, counted: every admission decision of the window
 * (default 30 days) per rule or check. The Guardrails page reads it for
 * "stopped N" and "on Block it would have stopped N"; the CI page reads the
 * image checks' blocked counts. A query over the AuditLog rows the admission
 * gate writes; nothing is stored twice.
 */

export const TALLY_DAYS = 30;
/** One read's ceiling; past it every count is a floor (`capped`). */
export const TALLY_CAP = 5_000;

export async function admissionTally(ctx: OrgContext, input: AdmissionTallyInput): Promise<AdmissionTallyView> {
  const days = input.days ?? TALLY_DAYS;
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await ctx.db.auditLog.findMany({
    where: { orgId: ctx.activeOrgId, action: { in: [...ADMISSION_ACTION_LIST] }, ts: { gte: since } },
    orderBy: { ts: 'desc' },
    take: TALLY_CAP,
    select: { action: true, targetId: true, metadata: true },
  });
  return { days, since: since.toISOString(), capped: rows.length >= TALLY_CAP, ...tallyAdmission(rows) };
}
