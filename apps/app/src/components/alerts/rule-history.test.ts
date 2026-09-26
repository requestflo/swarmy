import { describe, expect, test } from 'bun:test';
import type { AlertEventView } from '@swarmy/core';
import { WEEK_MS, spanWords, weekHistory } from './rule-history';

const now = Date.parse('2026-09-26T12:00:00Z');
const ev = (signal: string, minutesAgo: number, resolved: boolean): AlertEventView => ({
  id: `${signal}-${minutesAgo}`, ruleId: null, ruleName: null, signal, severity: 'warning', resource: 'service:checkout',
  message: '', status: resolved ? 'resolved' : 'firing', firedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  resolvedAt: resolved ? new Date(now - (minutesAgo - 10) * 60_000).toISOString() : null,
});

describe('weekHistory', () => {
  test('counts only this signal inside the last 7 days, oldest first', () => {
    const events = [ev('error-rate', 18, false), ev('error-rate', 3000, true), ev('disk-usage', 60, true), ev('error-rate', WEEK_MS / 60_000 + 60, true)];
    const h = weekHistory(events, 'error-rate', now, false);
    expect(h.fires.map((f) => f.end === null)).toEqual([false, true]);
    expect(h.partial).toBe(false);
  });
  test('a full page that stops short of a week is a floor', () => {
    expect(weekHistory([ev('error-rate', 30, true)], 'error-rate', now, true).partial).toBe(true);
  });
});

test('spanWords', () => {
  expect(spanWords(40_000)).toBe('40 s');
  expect(spanWords(18 * 60_000)).toBe('18 min');
  expect(spanWords(125 * 60_000)).toBe('2 h 5 min');
});
