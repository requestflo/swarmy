import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { notifyChannels, parseChannelIds } from './alerts.service';
import type { AlertNotification } from './alerts.service';

/**
 * Alert firing helper (slice C3) — the one entry point other slices use to
 * raise an alert event. Used by jobs (B2), exposure audit (E3), db failover
 * (A2), deploy safety (D1), queue reconcile (B1) and the alert-evaluator
 * worker.
 *
 * Semantics:
 * - The event is attributed to `ruleId` when given, else to the org's rule for
 *   the signal (custom rules win over the seeded default). A DISABLED matching
 *   rule mutes the signal entirely.
 * - Dedupe axis: (rule | signal) + resource. While an event is open (FIRING)
 *   repeated fires refresh its message/severity instead of stacking rows
 *   (`AlertEvent` has no lastSeen column — the open row itself is the "still
 *   firing" marker; the evaluator resolves it when the condition clears).
 * - Notifications go to the channels bound to the rule, or to every enabled
 *   channel when the rule binds none / no rule matches (org-default set).
 * - `status: 'resolved'` routes to `resolveEvent` so out-of-package callers
 *   (workers can only import the `@swarmy/trpc` root) can close events through
 *   this same contract. The original spine signature is unchanged — the field
 *   is optional.
 */

export interface FireEventInput {
  signal: string;
  severity: 'info' | 'warning' | 'critical';
  resource: string;
  message: string;
  ruleId?: string;
  /** 'firing' (default) raises/refreshes; 'resolved' closes + notifies recovery. */
  status?: 'firing' | 'resolved';
}

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  channelIds: unknown;
}

/** Custom rules beat the seeded default for the same signal. */
async function matchRule(ctx: OrgContext, input: FireEventInput): Promise<RuleRow | null> {
  if (input.ruleId) {
    return ctx.db.alertRule.findFirst({
      where: { id: input.ruleId, orgId: ctx.activeOrgId },
      select: { id: true, name: true, enabled: true, channelIds: true },
    });
  }
  return ctx.db.alertRule.findFirst({
    where: { orgId: ctx.activeOrgId, signal: input.signal },
    orderBy: [{ isDefault: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, enabled: true, channelIds: true },
  });
}

/** The rule's bound channels, or null = "org-default set" (every enabled channel). */
function ruleChannels(rule: RuleRow | null): string[] | null {
  if (!rule) return null;
  const ids = parseChannelIds(rule.channelIds);
  return ids.length > 0 ? ids : null;
}

/** Raise (or dedupe into) an alert event and notify its channels. */
export async function fireEvent(ctx: OrgContext, input: FireEventInput): Promise<void> {
  if (input.status === 'resolved') {
    await resolveEvent(ctx, input.signal, input.resource, input.message);
    return;
  }
  const rule = await matchRule(ctx, input);
  if (rule && !rule.enabled) return; // the signal is muted

  const open = await ctx.db.alertEvent.findFirst({
    where: {
      orgId: ctx.activeOrgId,
      resource: input.resource,
      status: 'FIRING',
      ...(rule ? { ruleId: rule.id } : { signal: input.signal }),
    },
    select: { id: true },
  });
  if (open) {
    // Still firing — refresh the row instead of stacking a duplicate.
    await ctx.db.alertEvent.update({
      where: { id: open.id },
      data: { message: input.message, severity: input.severity },
    });
    return;
  }

  const event = await ctx.db.alertEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      ruleId: rule?.id ?? null,
      signal: input.signal,
      severity: input.severity,
      resource: input.resource,
      message: input.message,
      status: 'FIRING',
    },
  });
  await writeAudit(ctx, {
    action: 'alert.fire',
    actorType: 'system',
    targetType: 'alertEvent',
    targetId: event.id,
    metadata: { signal: input.signal, resource: input.resource, severity: input.severity },
  });
  const notification: AlertNotification = {
    kind: 'firing',
    signal: input.signal,
    severity: input.severity,
    resource: input.resource,
    message: input.message,
    ruleName: rule?.name ?? null,
    at: event.firedAt.toISOString(),
    eventId: event.id,
  };
  await notifyChannels(ctx, ruleChannels(rule), notification).catch(() => undefined);
}

/** Close every open event for (signal, resource) and notify recovery. */
export async function resolveEvent(
  ctx: OrgContext,
  signal: string,
  resource: string,
  message?: string,
): Promise<void> {
  const open = await ctx.db.alertEvent.findMany({
    where: { orgId: ctx.activeOrgId, signal, resource, status: 'FIRING' },
    include: { rule: { select: { id: true, name: true, enabled: true, channelIds: true } } },
  });
  if (open.length === 0) return;
  const now = new Date();
  await ctx.db.alertEvent.updateMany({
    where: { id: { in: open.map((e) => e.id) } },
    data: { status: 'RESOLVED', resolvedAt: now },
  });
  for (const event of open) {
    await writeAudit(ctx, {
      action: 'alert.resolve',
      actorType: 'system',
      targetType: 'alertEvent',
      targetId: event.id,
      metadata: { signal, resource },
    });
    const notification: AlertNotification = {
      kind: 'resolved',
      signal,
      resource,
      severity: 'info',
      message: message ?? `${signal} on ${resource} recovered`,
      ruleName: event.rule?.name ?? null,
      at: now.toISOString(),
      eventId: event.id,
    };
    await notifyChannels(ctx, ruleChannels(event.rule), notification).catch(() => undefined);
  }
}
