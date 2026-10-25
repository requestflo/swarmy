import { describe, expect, test } from 'bun:test';
import { RENEW_COST, renewBlockedLine, renewOutcomeTone } from './renew-words';

const NOW = Date.parse('2026-10-24T12:00:00Z');

describe('Renew now, said', () => {
  test('offered: nothing blocks it, and the cost is said up front', () => {
    expect(renewBlockedLine({ available: true }, NOW)).toBeNull();
    expect(RENEW_COST).toContain("5-a-week Let's Encrypt certificates");
  });

  test('not offered: the reason, and when it opens again (time today, date later)', () => {
    expect(renewBlockedLine({ available: false, why: 'shared_store', reason: 'Front doors share one certificate store.' }, NOW)).toBe('Front doors share one certificate store.');
    expect(renewBlockedLine({ available: false, why: 'rate', reason: 'Less than an hour ago.', retryAt: '2026-10-24T12:59:00.000Z' }, NOW)).toBe('Less than an hour ago. Again from 12:59 UTC.');
    expect(renewBlockedLine({ available: false, why: 'rate', reason: 'Three this week.', retryAt: '2026-10-27T09:00:00.000Z' }, NOW)).toBe('Three this week. Again from 27 Oct.');
  });

  test('the toast after it ran', () => {
    expect(renewOutcomeTone('renewed')).toBe('success');
    expect(renewOutcomeTone('restored')).toBe('info');
    expect(renewOutcomeTone('failed')).toBe('error');
  });
});
