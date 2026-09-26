import { describe, expect, it } from 'bun:test';
import { inQuietHours, localMinutes, parseHhmm, quietHoursRange } from './alert-quiet-hours';

const q = { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC' };
const at = (iso: string): Date => new Date(iso);

describe('quiet hours window', () => {
  it('parses HH:MM', () => {
    expect(parseHhmm('22:00')).toBe(1320);
    expect(parseHhmm('7:00')).toBeNull();
    expect(parseHhmm('24:00')).toBeNull();
  });
  it('wraps past midnight', () => {
    expect(inQuietHours(q, at('2026-09-26T21:59:00Z'))).toBe(false);
    expect(inQuietHours(q, at('2026-09-26T22:00:00Z'))).toBe(true);
    expect(inQuietHours(q, at('2026-09-27T03:00:00Z'))).toBe(true);
    expect(inQuietHours(q, at('2026-09-27T07:00:00Z'))).toBe(false);
  });
  it('handles a same-day window', () => {
    const lunch = { ...q, start: '12:00', end: '13:00' };
    expect(inQuietHours(lunch, at('2026-09-26T12:30:00Z'))).toBe(true);
    expect(inQuietHours(lunch, at('2026-09-26T13:30:00Z'))).toBe(false);
  });
  it('reads the wall clock in the time zone', () => {
    // 21:30 UTC is 22:30 in London (BST, late September).
    expect(localMinutes(at('2026-09-26T21:30:00Z'), 'Europe/London')).toBe(22 * 60 + 30);
    expect(inQuietHours({ ...q, timeZone: 'Europe/London' }, at('2026-09-26T21:30:00Z'))).toBe(true);
    expect(inQuietHours(q, at('2026-09-26T21:30:00Z'))).toBe(false);
  });
  it('is never quiet when off, empty or malformed', () => {
    expect(inQuietHours({ ...q, enabled: false }, at('2026-09-27T03:00:00Z'))).toBe(false);
    expect(inQuietHours({ ...q, end: '22:00' }, at('2026-09-27T22:30:00Z'))).toBe(false);
    expect(inQuietHours({ ...q, start: 'late' }, at('2026-09-27T03:00:00Z'))).toBe(false);
    expect(inQuietHours(null, at('2026-09-27T03:00:00Z'))).toBe(false);
  });
  it('says the range', () => {
    expect(quietHoursRange(q)).toBe('22:00–07:00');
  });
});
