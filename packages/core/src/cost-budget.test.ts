import { describe, expect, it } from 'bun:test';
import {
  budgetAlertFiring,
  budgetAlertMessage,
  budgetStatus,
  lastWeeklySlot,
  monthProgress,
  weeklySummaryDue,
  weeklySummaryText,
} from './cost-budget';
import { ALERT_SIGNAL_INFO } from './views';

describe('budgetStatus', () => {
  it('has no status without a budget', () => {
    expect(budgetStatus(214, null, 80)).toBeNull();
    expect(budgetStatus(214, 0, 80)).toBeNull();
  });
  it('reads ok below the warn %, warn at/above it, over at 100%', () => {
    expect(budgetStatus(214, 300, 80)).toEqual({ budgetUsd: 300, projectedUsd: 214, usedPct: 71, warnPct: 80, state: 'ok' });
    expect(budgetStatus(240, 300, 80)?.state).toBe('warn');
    expect(budgetStatus(300, 300, 80)?.state).toBe('over');
    expect(budgetStatus(330, 300, 80)?.usedPct).toBe(110);
  });
});

describe('budget alert', () => {
  it('never fires without a budget', () => {
    expect(budgetAlertFiring(10_000, null, 80)).toBe(false);
  });
  it('fires when the projected month reaches the threshold % and not below', () => {
    expect(budgetAlertFiring(239, 300, 80)).toBe(false);
    expect(budgetAlertFiring(240, 300, 80)).toBe(true);
  });
  it('says it plainly', () => {
    expect(budgetAlertMessage(255, 300, 80)).toBe('On track to spend $255 this month — 85% of the $300 budget (warns at 80%)');
  });
  it('is a default warning at 80% with no target', () => {
    expect(ALERT_SIGNAL_INFO['cost-budget']).toMatchObject({ defaultThreshold: 80, unit: '%', severity: 'warning', target: null });
  });
});

describe('weeklySummaryText', () => {
  it('matches the owner’s sentence', () => {
    expect(weeklySummaryText({ projectedUsd: 214, budgetUsd: 300, top: { app: 'storefront', monthlyUsd: 82.4 } })).toBe(
      '$214 of $300 this month (71%). On track to land at $214. Biggest: storefront $82.',
    );
  });
  it('says over budget by how much', () => {
    expect(weeklySummaryText({ projectedUsd: 320, budgetUsd: 300, top: null })).toBe(
      '$320 of $300 this month (107%). On track to land at $320, over budget by $20.',
    );
  });
  it('works without a budget', () => {
    expect(weeklySummaryText({ projectedUsd: 1214, budgetUsd: null, top: null })).toBe('$1,214 a month at today’s server prices.');
  });
});

describe('weekly schedule (Monday 09:00 local)', () => {
  // 2026-09-28 is a Monday.
  it('finds the last Monday 09:00 in UTC and in a zone', () => {
    expect(lastWeeklySlot(new Date('2026-09-30T12:34:56Z'), 'UTC').toISOString()).toBe('2026-09-28T09:00:00.000Z');
    expect(lastWeeklySlot(new Date('2026-09-28T08:59:00Z'), 'UTC').toISOString()).toBe('2026-09-21T09:00:00.000Z');
    // London is UTC+1 in September: 09:00 local = 08:00Z.
    expect(lastWeeklySlot(new Date('2026-09-28T08:30:00Z'), 'Europe/London').toISOString()).toBe('2026-09-28T08:00:00.000Z');
  });
  it('is due once per slot, and not days late', () => {
    const mon = new Date('2026-09-28T09:05:00Z');
    expect(weeklySummaryDue(mon, null, 'UTC')).toBe(true);
    expect(weeklySummaryDue(mon, new Date('2026-09-21T09:01:00Z'), 'UTC')).toBe(true);
    expect(weeklySummaryDue(mon, new Date('2026-09-28T09:00:30Z'), 'UTC')).toBe(false);
    expect(weeklySummaryDue(new Date('2026-09-28T08:59:00Z'), new Date('2026-09-21T09:01:00Z'), 'UTC')).toBe(false);
    expect(weeklySummaryDue(new Date('2026-09-30T09:05:00Z'), null, 'UTC')).toBe(false);
  });
  it('falls back to UTC on a bad zone', () => {
    expect(lastWeeklySlot(new Date('2026-09-30T12:00:00Z'), 'Not/AZone').toISOString()).toBe('2026-09-28T09:00:00.000Z');
  });
});

describe('monthProgress', () => {
  it('counts days into the month', () => {
    expect(monthProgress(new Date('2026-09-24T10:00:00Z'))).toEqual({ day: 24, days: 30 });
  });
});
