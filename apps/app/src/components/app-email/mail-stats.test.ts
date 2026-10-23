import { describe, expect, test } from 'bun:test';
import { LOG_LIMIT, mailStats, statsLine } from './mail-stats';

const now = new Date(2026, 9, 24, 15, 0, 0);
const at = (h: number, day = 24): string => new Date(2026, 9, day, h, 0, 0).toISOString();

describe('mailStats', () => {
  test('counts accepted as sent and delivered over known outcomes, today only', () => {
    const s = mailStats(
      [
        [
          { ts: at(14), event: 'delivered' },
          { ts: at(14), event: 'accepted' },
          { ts: at(13), event: 'bounced' },
          { ts: at(13), event: 'accepted' },
          { ts: at(12), event: 'deferred' },
          { ts: at(10, 23), event: 'accepted' },
          { ts: at(10, 23), event: 'delivered' },
        ],
      ],
      now,
    );
    expect(s).toEqual({ sentToday: 2, capped: false, outcomes: 2, delivered: 1, deliveredPct: 50 });
    expect(statsLine(s)).toBe('2 sent today · 50% delivered');
  });

  test('no outcome yet is not a fake 0%', () => {
    const s = mailStats([[{ ts: at(9), event: 'accepted' }]], now);
    expect(s.deliveredPct).toBeNull();
    expect(statsLine(s)).toBe('1 sent today · nothing delivered or bounced yet');
  });

  test('a full page that never reaches midnight is a floor', () => {
    const page = Array.from({ length: LOG_LIMIT }, () => ({ ts: at(14), event: 'accepted' }));
    const s = mailStats([page], now);
    expect(s.capped).toBe(true);
    expect(statsLine(s)).toBe('500+ sent today · nothing delivered or bounced yet');
  });
});
