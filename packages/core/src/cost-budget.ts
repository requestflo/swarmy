/**
 * Workspace cost budget (owner decision Q6) — pure and browser-safe, so the
 * alert evaluator, the weekly summary worker and the dashboard say the same
 * numbers the same way.
 *
 * The "month" is an ESTIMATE: swarmy has no bill, only each server's monthly
 * price (the `swarmy.node.cost` label). The projected month total is today's
 * monthly run rate — the sum of the priced servers — so "used %" is
 * projected ÷ budget.
 */
import { localMinutes } from './alert-quiet-hours';
import type { CostBudgetStatusView } from './views';

/** The budget warning's resource key (one per workspace). */
export const COST_BUDGET_RESOURCE = 'org:budget';
/** The weekly summary goes out Monday at this local wall-clock time. */
export const WEEKLY_SUMMARY_DAY = 1; // Monday (0 = Sunday)
export const WEEKLY_SUMMARY_MINUTE = 9 * 60;
/** A summary missed by more than this (controller down all Monday) waits for next week. */
export const WEEKLY_SUMMARY_MAX_LATE_MS = 24 * 60 * 60_000;

const WEEK_MIN = 7 * 24 * 60;

/** "$214" — whole dollars with thousands separators. */
export function usdWhole(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Where the month stands; null without a (positive) budget. */
export function budgetStatus(
  projectedUsd: number,
  budgetUsd: number | null | undefined,
  warnPct: number,
): CostBudgetStatusView | null {
  if (budgetUsd == null || !(budgetUsd > 0)) return null;
  const exact = (projectedUsd / budgetUsd) * 100;
  const usedPct = Math.round(exact);
  const state = exact >= 100 ? 'over' : exact >= warnPct ? 'warn' : 'ok';
  return { budgetUsd, projectedUsd, usedPct, warnPct, state };
}

/** Should the budget warning be firing at this threshold? No budget → never. */
export function budgetAlertFiring(projectedUsd: number, budgetUsd: number | null | undefined, thresholdPct: number): boolean {
  if (budgetUsd == null || !(budgetUsd > 0)) return false;
  return (projectedUsd / budgetUsd) * 100 >= thresholdPct;
}

/** The alert message: "On track to spend $254 this month — 85% of the $300 budget (warns at 80%)". */
export function budgetAlertMessage(projectedUsd: number, budgetUsd: number, thresholdPct: number): string {
  const pct = Math.round((projectedUsd / budgetUsd) * 100);
  return `On track to spend ${usdWhole(projectedUsd)} this month — ${pct}% of the ${usdWhole(budgetUsd)} budget (warns at ${thresholdPct}%)`;
}

export interface WeeklySummaryInput {
  projectedUsd: number;
  budgetUsd: number | null;
  /** The app spending the most, when any app is priced. */
  top: { app: string; monthlyUsd: number } | null;
}

/**
 * The weekly message, one plain paragraph:
 * "$214 of $300 this month (71%). On track to land at $214. Biggest: storefront $82."
 */
export function weeklySummaryText(i: WeeklySummaryInput): string {
  const parts: string[] = [];
  if (i.budgetUsd != null && i.budgetUsd > 0) {
    const pct = Math.round((i.projectedUsd / i.budgetUsd) * 100);
    parts.push(`${usdWhole(i.projectedUsd)} of ${usdWhole(i.budgetUsd)} this month (${pct}%).`);
    parts.push(
      i.projectedUsd > i.budgetUsd
        ? `On track to land at ${usdWhole(i.projectedUsd)}, over budget by ${usdWhole(i.projectedUsd - i.budgetUsd)}.`
        : `On track to land at ${usdWhole(i.projectedUsd)}.`,
    );
  } else {
    parts.push(`${usdWhole(i.projectedUsd)} a month at today’s server prices.`);
  }
  if (i.top && i.top.monthlyUsd > 0) parts.push(`Biggest: ${i.top.app} ${usdWhole(i.top.monthlyUsd)}.`);
  return parts.join(' ');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day of week (0 = Sunday) at `now` in `timeZone` (UTC on a bad zone). */
export function localWeekday(now: Date, timeZone: string): number {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
    const i = WEEKDAYS.indexOf(wd);
    if (i >= 0) return i;
  } catch {
    // bad zone — UTC below
  }
  return now.getUTCDay();
}

/** The most recent Monday 09:00 (local to `timeZone`) at or before `now`. */
export function lastWeeklySlot(now: Date, timeZone: string): Date {
  const weekMin = ((localWeekday(now, timeZone) - WEEKLY_SUMMARY_DAY + 7) % 7) * 1440 + localMinutes(now, timeZone);
  const sinceSlot = (weekMin - WEEKLY_SUMMARY_MINUTE + WEEK_MIN) % WEEK_MIN;
  const floorMinute = now.getTime() - (now.getTime() % 60_000);
  return new Date(floorMinute - sinceSlot * 60_000);
}

/**
 * Is a weekly summary due? Once per Monday 09:00 slot: due when the latest
 * slot has passed, was not yet sent (`lastWeeklyAt` before it), and is less
 * than a day old (a summary missed all Monday waits for the next one).
 */
export function weeklySummaryDue(now: Date, lastWeeklyAt: Date | null, timeZone: string): boolean {
  const slot = lastWeeklySlot(now, timeZone);
  if (now.getTime() - slot.getTime() > WEEKLY_SUMMARY_MAX_LATE_MS) return false;
  return lastWeeklyAt === null || lastWeeklyAt.getTime() < slot.getTime();
}

/** "September" — the month an estimate belongs to. */
export function monthName(now: Date, timeZone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(now);
  }
}

/** Days into the month (1-based) and the month's length, in UTC. */
export function monthProgress(now: Date): { day: number; days: number } {
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { day: now.getUTCDate(), days };
}
