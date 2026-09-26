import {
  budgetStatus,
  lastWeeklySlot,
  weeklySummaryText,
  type AlertRuleView,
  type CostBudgetView,
  type CostOverviewView,
  type CostWeeklySummaryResult,
  type NotificationChannelView,
  type SetCostBudgetInput,
} from '@swarmy/core';
import type { DemoHandler, DemoStore } from '../types';

/**
 * Cost budget demo (owner decision Q6): a $300 budget with the month at ~70%,
 * the warning at 80% on the cost-budget alert rule (shared with the Alerts
 * demo, so the rule card and /cost agree) and the weekly summary on to the
 * #ops Slack channel. Mirrors cost-budget.service.ts views exactly.
 */

interface BudgetState {
  monthlyUsd: number | null;
  weeklySummary: boolean;
  /** null = not yet resolved to the seeded #ops Slack channel. */
  weeklyChannelIds: string[] | null;
  lastWeeklyAt: string;
}

interface AlertsLike {
  rules: AlertRuleView[];
  channels: NotificationChannelView[];
  quiet: { timeZone: string };
}

const alertsOf = (s: DemoStore): AlertsLike | undefined => s.extra.alerts as AlertsLike | undefined;
const budgetRule = (s: DemoStore): AlertRuleView | undefined =>
  alertsOf(s)?.rules.find((r) => r.signal === 'cost-budget' && r.isDefault);

export function seedBudget(): BudgetState {
  return {
    monthlyUsd: 300,
    weeklySummary: true,
    weeklyChannelIds: null,
    lastWeeklyAt: lastWeeklySlot(new Date(), 'UTC').toISOString(),
  };
}

function stateOf(s: DemoStore): BudgetState {
  const st = (s.extra.cost as { budget: BudgetState }).budget;
  if (st.weeklyChannelIds === null) {
    const slack = alertsOf(s)?.channels.find((c) => c.kind === 'slack');
    st.weeklyChannelIds = slack ? [slack.id] : [];
  }
  return st;
}

export function budgetHandlers(overview: (s: DemoStore) => CostOverviewView): Record<string, DemoHandler> {
  const view = (s: DemoStore): CostBudgetView => {
    const st = stateOf(s);
    const rule = budgetRule(s);
    const warnAtPct = rule?.threshold ?? 80;
    return {
      monthlyUsd: st.monthlyUsd,
      warnAtPct,
      warnChannelIds: rule?.channelIds ?? [],
      ruleId: rule?.id ?? null,
      warnEnabled: rule?.enabled ?? false,
      weeklySummary: st.weeklySummary,
      weeklyChannelIds: st.weeklyChannelIds ?? [],
      lastWeeklyAt: st.lastWeeklyAt,
      timeZone: alertsOf(s)?.quiet.timeZone ?? 'UTC',
      status: budgetStatus(overview(s).totals.monthlyUsd, st.monthlyUsd, warnAtPct),
    };
  };
  return {
    'cost.budget': (_i, s): CostBudgetView => view(s),
    'cost.setBudget': (i, s): CostBudgetView => {
      const b = i as SetCostBudgetInput;
      const st = stateOf(s);
      st.monthlyUsd = b.monthlyUsd;
      st.weeklySummary = b.weeklySummary;
      st.weeklyChannelIds = b.weeklyChannelIds;
      const rule = budgetRule(s);
      if (rule) {
        rule.threshold = b.warnAtPct;
        if (b.warnChannelIds !== undefined) rule.channelIds = b.warnChannelIds;
      }
      return view(s);
    },
    'cost.sendWeeklySummaryNow': (_i, s): CostWeeklySummaryResult => {
      const st = stateOf(s);
      const o = overview(s);
      const top = o.stacks[0];
      const text = weeklySummaryText({
        projectedUsd: o.totals.monthlyUsd,
        budgetUsd: st.monthlyUsd,
        top: top ? { app: top.stack, monthlyUsd: top.monthlyUsd } : null,
      });
      const channels = alertsOf(s)?.channels.filter((c) => c.enabled) ?? [];
      const ids = st.weeklyChannelIds ?? [];
      const sent = ids.length ? channels.filter((c) => ids.includes(c.id)).length : channels.length;
      return { text, sent, failed: 0 };
    },
  };
}
