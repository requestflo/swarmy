import { describe, expect, test } from 'bun:test';
import { appsLabel, expiresSoon, presetLabel, soonestExpiry, untilShort, untilWords } from './key-words';

const now = Date.parse('2026-09-26T00:00:00Z');
const at = (days: number): string => new Date(now + days * 86_400_000).toISOString();

describe('key words', () => {
  test('until', () => {
    expect(untilWords(at(12), now)).toBe('in 12 days');
    expect(untilWords(at(0.25), now)).toBe('in 6 hours');
    expect(untilShort(at(5), now)).toBe('5 d');
    expect(untilShort(at(-1), now)).toBe('expired');
  });
  test('expiresSoon: active and within 30 days', () => {
    expect(expiresSoon({ status: 'active', expiresAt: at(12) }, now)).toBe(true);
    expect(expiresSoon({ status: 'active', expiresAt: at(90) }, now)).toBe(false);
    expect(expiresSoon({ status: 'active', expiresAt: null }, now)).toBe(false);
    expect(expiresSoon({ status: 'revoked', expiresAt: at(2) }, now)).toBe(false);
  });
  test('soonestExpiry', () => {
    const k = (d: number | null) => ({ status: 'active', expiresAt: d === null ? null : at(d), preset: 'deploy' as const, scopes: ['read', 'deploy'], stackNames: null });
    expect(soonestExpiry([k(12), k(null)], now)).toBe('One expires in 12 days.');
    expect(soonestExpiry([k(20), k(3)], now)).toBe('Two expire soon, the first in 3 days.');
    expect(soonestExpiry([k(200)], now)).toBeNull();
  });
  test('labels', () => {
    expect(presetLabel({ preset: 'deploy', scopes: ['read', 'deploy'] })).toBe('Deploy');
    expect(presetLabel({ preset: 'custom', scopes: ['read', 'write'] })).toBe('read, write');
    expect(appsLabel(null)).toBe('every app');
    expect(appsLabel(['a', 'b', 'c'])).toBe('a, b +1');
  });
});
