import {
  ALERT_SIGNAL_INFO,
  budgetStatus,
  weeklySummaryDue,
  weeklySummaryText,
  type CostBudgetView,
  type CostWeeklySummaryResult,
  type SetCostBudgetInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { deliverToChannel, ensureDefaultRules, parseChannelIds, type AlertNotification } from './alerts.service';
import { monthlyRunRate, overview } from './cost.service';

/**
 * Workspace cost budget (owner decision Q6): a monthly budget, a warning at
 * X% and a weekly cost summary through the alert channels. No blocking —
 * swarmy never stops a deploy or a scale-up over money.
 *
 * - The budget + weekly settings are one `CostBudget` row per org.
 * - The warning is the `cost-budget` alert signal: the default rule's
 *   threshold IS the warn-at %, so it flows through the existing rules,
 *   channels, mute and quiet hours. The alert evaluator fires it (resource
 *   `org:budget`) while the projected month — today's monthly run rate from
 *   server prices — is at or above threshold% of the budget.
 * - The weekly summary goes out Monday 09:00 in the workspace's quiet-hours
 *   time zone (UTC without one) from the `cost-weekly-summary` worker,
 *   idempotent via `lastWeeklyAt`; `sendWeeklySummaryNow` is the test button
 *   and uses the same text.
 */

export const COST_BUDGET_SIGNAL = 'cost-budget';
const DEFAULT_WARN = ALERT_SIGNAL_INFO['cost-budget'].defaultThreshold ?? 80;

interface BudgetRow {
  monthlyUsd: number | null;
  weeklySummary: boolean;
  weeklyChannelIds: unknown;
  lastWeeklyAt: Date | null;
}

/** The default cost-budget rule (null when the org opted out of it). */
async function budgetRule(
  ctx: OrgContext,
): Promise<{ id: string; threshold: number | null; channelIds: unknown; enabled: boolean } | null> {
  return ctx.db.alertRule.findFirst({
    where: { orgId: ctx.activeOrgId, signal: COST_BUDGET_SIGNAL, isDefault: true, optedOutAt: null },
    select: { id: true, threshold: true, channelIds: true, enabled: true },
  });
}

/** The zone the weekly send uses: the quiet-hours zone when a row exists, else UTC. */
export async function budgetTimeZone(ctx: Pick<OrgContext, 'db' | 'activeOrgId'>): Promise<string> {
  const q = await ctx.db.alertQuietHours.findUnique({ where: { orgId: ctx.activeOrgId }, select: { timeZone: true } });
  return q?.timeZone || 'UTC';
}

export async function getBudget(ctx: OrgContext): Promise<CostBudgetView> {
  await ensureDefaultRules(ctx).catch(() => undefined);
  const [row, rule, rate, timeZone] = await Promise.all([
    ctx.db.costBudget.findUnique({ where: { orgId: ctx.activeOrgId } }) as Promise<BudgetRow | null>,
    budgetRule(ctx),
    monthlyRunRate(ctx),
    budgetTimeZone(ctx),
  ]);
  const warnAtPct = rule?.threshold ?? DEFAULT_WARN;
  const monthlyUsd = row?.monthlyUsd ?? null;
  return {
    monthlyUsd,
    warnAtPct,
    warnChannelIds: parseChannelIds(rule?.channelIds),
    ruleId: rule?.id ?? null,
    warnEnabled: rule?.enabled ?? false,
    weeklySummary: row?.weeklySummary ?? false,
    weeklyChannelIds: parseChannelIds(row?.weeklyChannelIds),
    lastWeeklyAt: row?.lastWeeklyAt?.toISOString() ?? null,
    timeZone,
    status: budgetStatus(rate.monthlyUsd, monthlyUsd, warnAtPct),
  };
}

/** Save the budget; the warn-at % (and channels) go onto the cost-budget rule. Audited. */
export async function setBudget(ctx: OrgContext, input: SetCostBudgetInput): Promise<CostBudgetView> {
  const data = {
    monthlyUsd: input.monthlyUsd,
    weeklySummary: input.weeklySummary,
    weeklyChannelIds: input.weeklyChannelIds,
  };
  await ctx.db.costBudget.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, ...data },
    update: data,
  });
  await ensureDefaultRules(ctx).catch(() => undefined);
  const rule = await budgetRule(ctx);
  if (rule) {
    await ctx.db.alertRule.update({
      where: { id: rule.id },
      data: {
        threshold: input.warnAtPct,
        ...(input.warnChannelIds !== undefined ? { channelIds: input.warnChannelIds } : {}),
      },
    });
  }
  await writeAudit(ctx, {
    action: 'cost.budget.set',
    targetType: 'costBudget',
    targetId: ctx.activeOrgId,
    metadata: {
      monthlyUsd: input.monthlyUsd,
      warnAtPct: input.warnAtPct,
      weeklySummary: input.weeklySummary,
      weeklyChannels: input.weeklyChannelIds.length,
      ruleId: rule?.id ?? null,
    },
  });
  return getBudget(ctx);
}

/** The weekly text from the live numbers (the full overview, for the biggest app). */
export async function weeklySummaryFor(ctx: OrgContext, budgetUsd: number | null): Promise<string> {
  const o = await overview(ctx);
  const top = o.stacks[0];
  return weeklySummaryText({
    projectedUsd: o.totals.monthlyUsd,
    budgetUsd,
    top: top ? { app: top.stack, monthlyUsd: top.monthlyUsd } : null,
  });
}

/** Deliver one plain summary message to the chosen channels ([] = every enabled one). */
export async function deliverSummary(ctx: OrgContext, channelIds: string[], text: string): Promise<{ sent: number; failed: number }> {
  const rows = await ctx.db.notificationChannel.findMany({
    where: { orgId: ctx.activeOrgId, enabled: true, ...(channelIds.length ? { id: { in: channelIds } } : {}) },
  });
  const n: AlertNotification = {
    kind: 'summary',
    signal: 'cost-weekly-summary',
    severity: 'info',
    resource: 'org:budget',
    message: text,
    ruleName: 'Weekly cost summary',
    at: new Date().toISOString(),
    eventId: null,
  };
  const results = await Promise.allSettled(rows.map((row) => deliverToChannel(ctx, row as Parameters<typeof deliverToChannel>[1], n)));
  const sent = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
  return { sent, failed: rows.length - sent };
}

/** Compose + deliver the summary with the org's saved settings. */
export async function sendSummary(ctx: OrgContext): Promise<CostWeeklySummaryResult> {
  const row = (await ctx.db.costBudget.findUnique({ where: { orgId: ctx.activeOrgId } })) as BudgetRow | null;
  const text = await weeklySummaryFor(ctx, row?.monthlyUsd ?? null);
  const r = await deliverSummary(ctx, parseChannelIds(row?.weeklyChannelIds), text);
  return { text, ...r };
}

/** "Send a test summary now": same text, same channels; never moves the weekly clock. Audited. */
export async function sendWeeklySummaryNow(ctx: OrgContext): Promise<CostWeeklySummaryResult> {
  const result = await sendSummary(ctx);
  await writeAudit(ctx, {
    action: 'cost.weeklySummary.test',
    targetType: 'costBudget',
    targetId: ctx.activeOrgId,
    metadata: { sent: result.sent, failed: result.failed },
  });
  return result;
}

export type WeeklyRunOutcome = 'off' | 'not-due' | 'claimed-elsewhere' | 'sent';

/**
 * The worker's per-org step: when the summary is on and this Monday 09:00
 * slot hasn't been sent, CLAIM it (a conditional `lastWeeklyAt` update, so
 * two ticks or two controllers never double-send), then send. `now` and
 * `send` are injectable for tests.
 */
export async function runWeeklySummary(
  ctx: OrgContext,
  now: Date,
  send: (ctx: OrgContext) => Promise<CostWeeklySummaryResult> = sendSummary,
): Promise<WeeklyRunOutcome> {
  const row = (await ctx.db.costBudget.findUnique({ where: { orgId: ctx.activeOrgId } })) as BudgetRow | null;
  if (!row?.weeklySummary) return 'off';
  const tz = await budgetTimeZone(ctx);
  if (!weeklySummaryDue(now, row.lastWeeklyAt, tz)) return 'not-due';
  const claimed = await ctx.db.costBudget.updateMany({
    where: { orgId: ctx.activeOrgId, lastWeeklyAt: row.lastWeeklyAt },
    data: { lastWeeklyAt: now },
  });
  if (claimed.count === 0) return 'claimed-elsewhere';
  const result = await send(ctx);
  await writeAudit(ctx, {
    action: 'cost.weeklySummary.sent',
    actorType: 'system',
    targetType: 'costBudget',
    targetId: ctx.activeOrgId,
    metadata: { sent: result.sent, failed: result.failed },
  });
  return 'sent';
}
