import {
  EVENT_ALERT_SIGNALS,
  inQuietHours,
  parseAlertSelector,
  selectorMatches,
  subjectFromResource,
  type QuietHoursLike,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { notifyChannels, parseChannelIds } from './alerts.service';
import type { AlertNotification } from './alerts.service';

/**
 * Alert firing helper (slice C3, reshaped by owner decision Q10) — the one
 * entry point other slices use to raise an alert event. Used by jobs (B2),
 * exposure audit (E3), db failover (A2), deploy safety (D1), queue reconcile
 * (B1) and the alert-evaluator worker.
 *
 * Semantics:
 * - Several rules per signal. With `ruleId` the event belongs to that rule;
 *   without it, it fans out to EVERY enabled rule for the signal whose target
 *   (`selectorJson`) covers the event's subject (`subjectFromResource`). No
 *   rule row at all for the signal → one ruleless event to every channel; rule
 *   rows but none enabled + matching → nothing (a disabled rule mutes).
 * - Dedupe axis: (ruleId, resource) — each rule dedupes its own events
 *   (ruleless: (signal, resource)). While an event is open repeated fires
 *   refresh its message/severity instead of stacking rows. Event-style signals
 *   (`EVENT_ALERT_SIGNALS`) refresh the open row but RE-NOTIFY each time.
 * - Notify decision (`notifyDecision`): a rule muted until later records the
 *   event as MUTED and sends nothing; during workspace quiet hours anything
 *   below a paging critical is recorded as HELD. `releaseHeld` (every
 *   evaluator tick, and on unmute / quiet-hours change) sends each still-firing
 *   HELD/MUTED event once when its hold is over. Resolving a HELD/MUTED event
 *   marks it SKIPPED — it is never sent.
 * - Notifications go to the channels bound to the rule, or to every enabled
 *   channel when the rule binds none / no rule exists (org-default set).
 * - `status: 'resolved'` routes to `resolveEvent` so out-of-package callers
 *   close events through this same contract.
 */

export interface FireEventInput {
  signal: string;
  severity: 'info' | 'warning' | 'critical';
  resource: string;
  message: string;
  /** Attribute to exactly this rule (the evaluator: it already matched targets). */
  ruleId?: string;
  /** 'firing' (default) raises/refreshes; 'resolved' closes + notifies recovery. */
  status?: 'firing' | 'resolved';
}

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  channelIds: unknown;
  selectorJson: unknown;
  mutedUntil: Date | null;
}

const RULE_SELECT = {
  id: true,
  name: true,
  enabled: true,
  channelIds: true,
  selectorJson: true,
  mutedUntil: true,
} as const;

export interface QuietHoursRow extends QuietHoursLike {
  criticalPages: boolean;
}

export type NotifyDecision = 'send' | 'hold' | 'mute';

/**
 * Pure: may this notification go out now? A muted rule wins (nothing is sent
 * until the mute ends); then quiet hours hold everything except a critical
 * alert while "critical alerts still page" is on.
 */
export function notifyDecision(args: {
  severity: string;
  mutedUntil: Date | null | undefined;
  quiet: QuietHoursRow | null | undefined;
  now: Date;
}): NotifyDecision {
  if (args.mutedUntil && args.mutedUntil.getTime() > args.now.getTime()) return 'mute';
  if (args.quiet && inQuietHours(args.quiet, args.now)) {
    if (args.severity === 'critical' && args.quiet.criticalPages) return 'send';
    return 'hold';
  }
  return 'send';
}

const NOTIFY_STATE = { send: 'SENT', hold: 'HELD', mute: 'MUTED' } as const;

/** Is this rule muted at `now`? */
export function isRuleMuted(rule: { mutedUntil: Date | null } | null | undefined, now: Date): boolean {
  return Boolean(rule?.mutedUntil && rule.mutedUntil.getTime() > now.getTime());
}

/** The org's quiet hours row (null = never quiet). */
export async function loadQuietHours(ctx: OrgContext): Promise<QuietHoursRow | null> {
  const row = await ctx.db.alertQuietHours.findUnique({ where: { orgId: ctx.activeOrgId } });
  return row
    ? { enabled: row.enabled, start: row.start, end: row.end, timeZone: row.timeZone, criticalPages: row.criticalPages }
    : null;
}

/** The rule's bound channels, or null = "org-default set" (every enabled channel). */
function ruleChannels(rule: Pick<RuleRow, 'channelIds'> | null): string[] | null {
  if (!rule) return null;
  const ids = parseChannelIds(rule.channelIds);
  return ids.length > 0 ? ids : null;
}

/**
 * Which rules an event belongs to. `null` in the list = a ruleless event (the
 * signal has no rule row at all).
 */
async function targetRules(ctx: OrgContext, input: FireEventInput): Promise<Array<RuleRow | null>> {
  if (input.ruleId) {
    const rule = await ctx.db.alertRule.findFirst({
      where: { id: input.ruleId, orgId: ctx.activeOrgId },
      select: RULE_SELECT,
    });
    return rule && rule.enabled ? [rule] : [];
  }
  const rules = await ctx.db.alertRule.findMany({
    where: { orgId: ctx.activeOrgId, signal: input.signal },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: RULE_SELECT,
  });
  if (rules.length === 0) return [null];
  const subject = subjectFromResource(input.resource);
  return rules.filter((r) => r.enabled && selectorMatches(parseAlertSelector(r.selectorJson), subject));
}

/** Raise (or dedupe into) an alert event per matching rule and notify its channels. */
export async function fireEvent(ctx: OrgContext, input: FireEventInput): Promise<void> {
  if (input.status === 'resolved') {
    await resolveEvent(ctx, input.signal, input.resource, input.message, input.ruleId);
    return;
  }
  const rules = await targetRules(ctx, input);
  if (rules.length === 0) return;
  const quiet = await loadQuietHours(ctx);
  const now = new Date();
  for (const rule of rules) await fireForRule(ctx, input, rule, quiet, now);
}

async function fireForRule(
  ctx: OrgContext,
  input: FireEventInput,
  rule: RuleRow | null,
  quiet: QuietHoursRow | null,
  now: Date,
): Promise<void> {
  const decision = notifyDecision({ severity: input.severity, mutedUntil: rule?.mutedUntil, quiet, now });
  const notification = (eventId: string, at: Date): AlertNotification => ({
    kind: 'firing',
    signal: input.signal,
    severity: input.severity,
    resource: input.resource,
    message: input.message,
    ruleName: rule?.name ?? null,
    at: at.toISOString(),
    eventId,
  });

  const open = await ctx.db.alertEvent.findFirst({
    where: {
      orgId: ctx.activeOrgId,
      resource: input.resource,
      status: 'FIRING',
      ...(rule ? { ruleId: rule.id } : { ruleId: null, signal: input.signal }),
    },
    select: { id: true, notify: true },
  });
  if (open) {
    // Still firing — refresh the row instead of stacking a duplicate.
    const renotify = EVENT_ALERT_SIGNALS.includes(input.signal);
    // A repeat of an event-style signal that can't go out now is held/muted
    // (sent once later); a level signal keeps its existing notify state.
    const notify = renotify && decision !== 'send' && open.notify === 'SENT' ? NOTIFY_STATE[decision] : undefined;
    await ctx.db.alertEvent.update({
      where: { id: open.id },
      data: { message: input.message, severity: input.severity, ...(notify ? { notify } : {}) },
    });
    if (renotify && decision === 'send') {
      await notifyChannels(ctx, ruleChannels(rule), notification(open.id, now)).catch(() => undefined);
    }
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
      notify: NOTIFY_STATE[decision],
    },
  });
  await writeAudit(ctx, {
    action: 'alert.fire',
    actorType: 'system',
    targetType: 'alertEvent',
    targetId: event.id,
    metadata: {
      signal: input.signal,
      resource: input.resource,
      severity: input.severity,
      ruleId: rule?.id ?? null,
      ...(decision !== 'send' ? { notify: NOTIFY_STATE[decision] } : {}),
    },
  });
  if (decision === 'send') {
    await notifyChannels(ctx, ruleChannels(rule), notification(event.id, event.firedAt)).catch(() => undefined);
  }
}

/**
 * Close every open event for (signal, resource) — or only `ruleId`'s — and
 * notify recovery. A recovery is sent only when the firing was sent and the
 * notification could go out now (not muted, not held by quiet hours); a
 * HELD/MUTED event that resolves becomes SKIPPED and is never sent.
 */
export async function resolveEvent(
  ctx: OrgContext,
  signal: string,
  resource: string,
  message?: string,
  ruleId?: string,
): Promise<void> {
  const open = await ctx.db.alertEvent.findMany({
    where: { orgId: ctx.activeOrgId, signal, resource, status: 'FIRING', ...(ruleId ? { ruleId } : {}) },
    include: { rule: { select: RULE_SELECT } },
  });
  if (open.length === 0) return;
  const now = new Date();
  const quiet = await loadQuietHours(ctx);
  await ctx.db.alertEvent.updateMany({
    where: { id: { in: open.map((e) => e.id) } },
    data: { status: 'RESOLVED', resolvedAt: now },
  });
  const unsent = open.filter((e) => e.notify !== 'SENT' && e.notify !== 'SKIPPED').map((e) => e.id);
  if (unsent.length) {
    await ctx.db.alertEvent.updateMany({ where: { id: { in: unsent } }, data: { notify: 'SKIPPED' } });
  }
  for (const event of open) {
    await writeAudit(ctx, {
      action: 'alert.resolve',
      actorType: 'system',
      targetType: 'alertEvent',
      targetId: event.id,
      metadata: { signal, resource, ruleId: event.ruleId },
    });
    if (event.notify !== 'SENT') continue;
    // Judge the recovery by the severity it fired with: a paging critical's
    // recovery pages too; a warning's recovery waits out quiet hours (dropped).
    if (notifyDecision({ severity: event.severity, mutedUntil: event.rule?.mutedUntil, quiet, now }) !== 'send') continue;
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

/**
 * Send each still-firing HELD/MUTED event once its hold is over (quiet hours
 * ended, mute expired or lifted). Idempotent: the notify flip is conditional,
 * so two overlapping calls never double-send. Returns how many went out.
 */
export async function releaseHeld(ctx: OrgContext, now = new Date()): Promise<number> {
  const waiting = await ctx.db.alertEvent.findMany({
    where: { orgId: ctx.activeOrgId, status: 'FIRING', notify: { in: ['HELD', 'MUTED'] } },
    include: { rule: { select: RULE_SELECT } },
    orderBy: { firedAt: 'asc' },
  });
  if (waiting.length === 0) return 0;
  const quiet = await loadQuietHours(ctx);
  let sent = 0;
  for (const event of waiting) {
    const decision = notifyDecision({ severity: event.severity, mutedUntil: event.rule?.mutedUntil, quiet, now });
    const next = NOTIFY_STATE[decision];
    if (next === event.notify) continue;
    const flipped = await ctx.db.alertEvent.updateMany({
      where: { id: event.id, notify: event.notify, status: 'FIRING' },
      data: { notify: next },
    });
    if (flipped.count === 0 || decision !== 'send') continue;
    sent += 1;
    await writeAudit(ctx, {
      action: 'alert.release',
      actorType: 'system',
      targetType: 'alertEvent',
      targetId: event.id,
      metadata: { signal: event.signal, resource: event.resource, was: event.notify },
    });
    await notifyChannels(ctx, ruleChannels(event.rule), {
      kind: 'firing',
      signal: event.signal,
      severity: event.severity as AlertNotification['severity'],
      resource: event.resource,
      message: event.message,
      ruleName: event.rule?.name ?? null,
      at: now.toISOString(),
      eventId: event.id,
    }).catch(() => undefined);
  }
  return sent;
}
