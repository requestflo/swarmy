import { describe, expect, it } from 'bun:test';
import { EMPTY_HISTORY, noteCert, renewalWindow, RENEWALS_KEPT, type SeenCert } from './cert-renewal';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');

describe('renewalWindow (Caddy renews with a third of the lifetime left)', () => {
  it('a 90-day certificate renews 30 days before it expires', () => {
    expect(renewalWindow('2026-09-23T10:00:00Z', '2026-12-22T10:00:00Z', NOW)).toEqual({
      renewAt: '2026-11-22T10:00:00.000Z',
      lifetimeDays: 90,
      state: 'ahead',
      daysUntil: 29,
    });
  });

  it('a shorter certificate renews proportionally sooner', () => {
    const w = renewalWindow('2026-10-20T00:00:00Z', '2026-10-26T00:00:00Z', NOW);
    expect(w?.lifetimeDays).toBe(6);
    expect(w?.renewAt).toBe('2026-10-24T00:00:00.000Z');
    expect(w?.state).toBe('due');
    expect(w?.daysUntil).toBe(0);
  });

  it('expired, and nonsense dates', () => {
    expect(renewalWindow('2026-07-01T00:00:00Z', '2026-09-29T00:00:00Z', NOW)?.state).toBe('expired');
    expect(renewalWindow('x', '2026-09-29T00:00:00Z', NOW)).toBeNull();
    expect(renewalWindow('2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z', NOW)).toBeNull();
  });
});

const seen = (notBefore: string, serial: string): SeenCert => ({ notBefore, notAfter: new Date(Date.parse(notBefore) + 90 * DAY).toISOString(), serial, issuer: "Let's Encrypt R11" });

describe('noteCert (renewals are seen, not guessed)', () => {
  it('the first read is the baseline, not a renewal', () => {
    const h = noteCert(EMPTY_HISTORY, seen('2026-06-25T10:00:00.000Z', 'A'));
    expect(h.renewals).toEqual([]);
    expect(h.current?.serial).toBe('A');
  });

  it('a newer notBefore with another serial is a renewal; the same or an older copy is not', () => {
    let h = noteCert(EMPTY_HISTORY, seen('2026-06-25T10:00:00.000Z', 'A'));
    h = noteCert(h, seen('2026-06-25T10:00:00.000Z', 'A'));
    h = noteCert(h, seen('2026-09-23T10:00:00.000Z', 'B'));
    h = noteCert(h, seen('2026-06-25T10:00:00.000Z', 'A')); // an edge still on the old copy
    expect(h.renewals).toEqual([{ at: '2026-09-23T10:00:00.000Z', issuer: "Let's Encrypt R11", replaced: '2026-06-25T10:00:00.000Z', by: 'automatic' }]);
    expect(h.current?.serial).toBe('B');
  });

  it('after a Renew now the next renewal is credited to the request (notBefore is backdated an hour)', () => {
    const h = noteCert({ ...noteCert(EMPTY_HISTORY, seen('2026-09-23T10:00:00.000Z', 'B')), requestedAt: '2026-10-24T12:00:00.000Z' }, seen('2026-10-24T11:00:00.000Z', 'C'));
    expect(h.renewals[0]?.by).toBe('request');
    expect(h.requestedAt).toBeUndefined();
  });

  it(`keeps the newest ${RENEWALS_KEPT}`, () => {
    let h = noteCert(EMPTY_HISTORY, seen('2026-01-01T00:00:00.000Z', 's0'));
    for (let i = 1; i <= 7; i++) h = noteCert(h, seen(new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60 * DAY).toISOString(), `s${i}`));
    expect(h.renewals.length).toBe(RENEWALS_KEPT);
    expect(h.renewals[0]?.replaced).toBe(new Date(Date.parse('2026-01-01T00:00:00Z') + 6 * 60 * DAY).toISOString());
  });
});
