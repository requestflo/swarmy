import { describe, expect, it } from 'bun:test';
import { blockedWords, rateText } from './blocked-words';

describe('the protections receipt (board 30)', () => {
  it('says what was blocked at the address, never which rule did it', () => {
    const w = blockedWords({ perMin: 12, forbiddenPerMin: 9, tooManyPerMin: 3, windowMinutes: 5 }, 'shop.example.com', 'web')!;
    expect(w.head).toBe('Blocked 12 a minute');
    expect(w.note).toBe('over the last 5 minutes: refused at the front door, plus any refusals web sends itself.');
    expect(w.tech).toContain('403 9/min + 429 3/min');
    expect(w.tech).toContain('aren’t counted');
  });

  it('a real zero reads "Nothing blocked"; no number reads nothing at all', () => {
    expect(blockedWords({ perMin: 0, forbiddenPerMin: 0, tooManyPerMin: 0, windowMinutes: 5 }, 'a.test', 'web')).toMatchObject({ head: 'Nothing blocked', note: 'in the last 5 minutes.' });
    expect(blockedWords(null, 'a.test', 'web')).toBeNull();
  });

  it('rates keep a decimal when small', () => {
    expect([rateText(0.4), rateText(3), rateText(12.6), rateText(1234), rateText(23_456)]).toEqual(['0.4', '3', '13', '1.2k', '23k']);
  });
});
