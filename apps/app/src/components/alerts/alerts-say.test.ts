import { expect, test } from 'bun:test';
import type { AlertEventView, AlertsOverview } from '@swarmy/core';
import { alertsSay } from './alerts-say';

const o = (firing: number, critical = 0): AlertsOverview => ({ firing, firingCritical: critical, resolved24h: 0, rules: 18, rulesEnabled: 18, channels: 3 });
const ev = (ruleName: string, resource: string): AlertEventView => ({
  id: ruleName, ruleId: null, ruleName, signal: 'x', severity: 'warning', resource, message: '', status: 'firing', firedAt: '', resolvedAt: null,
});

test('all quiet', () => {
  expect(alertsSay(o(0), [])).toEqual({ alarm: null, lead: 'All quiet.', rest: '18 rules watching.' });
});

test('two firing on one app', () => {
  const s = alertsSay(o(2), [ev('App errors', 'service:checkout'), ev('Part short of copies', 'service:checkout')]);
  expect(s.alarm).toEqual({ text: '2 alerts firing.', tone: 'warn' });
  expect(s.rest).toBe('App errors and Part short of copies, both on checkout.');
});

test('critical turns the clause crimson', () => {
  expect(alertsSay(o(1, 1), [ev('Server offline', 'node:wkr-3')]).alarm?.tone).toBe('bad');
});
