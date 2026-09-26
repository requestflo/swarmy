import { describe, expect, test } from 'bun:test';
import type { LogRowView } from '@swarmy/core';
import { byLevel, errorParts, fingerprint, groupErrors, levelCounts, levelOf, lineTime, matchIssue, splitAtCutoff } from './stream-model';

const row = (sec: number, sev: number, part: string, body: string, trace = ''): LogRowView => ({
  timestamp: '', ts_nano: `${1_790_000_000_000 + sec * 1000}000000`, trace_id: trace, span_id: 's', severity_text: '', severity_number: sev, service_name: part, body, attributes: {},
});

const rows = [
  row(9, 17, 'checkout', 'charge failed for order #48204: stripe.paymentIntents.create timed out after 10000 ms', 't3'),
  row(8, 9, 'web', 'GET / 200 · 12 ms'),
  row(7, 13, 'checkout', 'cart_totals took 412 ms (budget 250 ms)'),
  row(6, 21, 'api', 'worker crashed: OOMKilled'),
  row(5, 17, 'checkout', 'charge failed for order #48203: stripe.paymentIntents.create timed out after 10000 ms', 't2'),
  row(4, 5, 'api', 'SELECT carts · 3 rows'),
  row(3, 1, 'api', 'trace line'),
  row(1, 17, 'checkout', 'charge failed for order #48202: stripe.paymentIntents.create timed out after 10000 ms'),
];

describe('levels', () => {
  test('fatal folds into error and trace into debug', () => {
    expect([21, 17, 13, 9, 5, 1].map(levelOf)).toEqual(['error', 'error', 'warn', 'info', 'debug', 'debug']);
  });
  test('counts every level and the total', () => {
    expect(levelCounts(rows)).toEqual({ all: 8, error: 4, warn: 1, info: 1, debug: 2 });
    expect(levelCounts([])).toEqual({ all: 0, error: 0, warn: 0, info: 0, debug: 0 });
  });
  test('filters to one level, or passes all through', () => {
    expect(byLevel(rows, 'warn').map((r) => r.body)).toEqual(['cart_totals took 412 ms (budget 250 ms)']);
    expect(byLevel(rows, 'all')).toBe(rows);
  });
});

describe('fingerprint + grouping', () => {
  test('masks numbers, ids and quoted values', () => {
    expect(fingerprint('charge failed for order #48204')).toBe(fingerprint('charge failed for order #1'));
    expect(fingerprint('created pi_3Qa81f2')).toBe(fingerprint('created pi_9Zz0011'));
    expect(fingerprint('user "ana" signed in')).toBe(fingerprint("user 'bo' signed in"));
    expect(fingerprint('cart_totals over budget')).toContain('cart_totals');
  });
  test('groups repeats per part with count, first/last seen and the newest trace', () => {
    const g = groupErrors(rows);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ part: 'checkout', count: 3, traceId: 't3', firstNano: rows[7]!.ts_nano, lastNano: rows[0]!.ts_nano });
    expect(g[0]!.message).toContain('#48204');
    expect(g[1]).toMatchObject({ part: 'api', count: 1, traceId: null });
  });
  test('the parts the errors came from, most first', () => {
    expect(errorParts(rows)).toEqual(['checkout', 'api']);
  });
  test('matches an error-tracking issue on the dotted call name in the same part', () => {
    const issues = [
      { fingerprint: 'aa', title: 'TypeError: applePaySession is undefined', culprit: 'checkout/src/pay.ts in startApplePay' },
      { fingerprint: 'bb', title: 'TimeoutError: stripe.paymentIntents.create timed out', culprit: 'checkout/src/stripe.ts in charge' },
    ];
    const [g] = groupErrors(rows);
    expect(matchIssue(g!, issues)).toBe('bb');
    expect(matchIssue({ ...g!, part: 'web' }, issues)).toBeNull();
    expect(matchIssue({ message: 'worker crashed: OOMKilled', part: 'api' }, issues)).toBeNull();
  });
});

describe('pause', () => {
  test('lines after the cutoff are counted, not shown', () => {
    const { shown, fresh } = splitAtCutoff(rows, rows[2]!.ts_nano);
    expect(fresh).toBe(2);
    expect(shown[0]).toBe(rows[2]);
    expect(splitAtCutoff(rows, null)).toEqual({ shown: rows, fresh: 0 });
  });
  test('line time is hh:mm:ss.mmm', () => {
    expect(lineTime(rows[0]!.ts_nano)).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
  });
});
