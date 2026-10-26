import { describe, expect, it } from 'bun:test';
import type { EstateUptimeView } from '@swarmy/core';
import { pctWords, spanWords, uptimeWords } from './uptime-words';

const ok = (over: Partial<EstateUptimeView> = {}): EstateUptimeView => ({
  state: 'ok', pct: 99.97, source: 'status-checks', windowDays: 30, coveredHours: 720, downMinutes: 13, ...over,
});

describe('uptimeWords', () => {
  it('says the figure and what it is from', () => {
    expect(uptimeWords(ok())).toEqual({
      figure: '99.97% up',
      basis: '30 days, from status checks',
      tech: 'estate.uptime · 720 h seen · 13 min not answering',
    });
  });

  it('says how much the edges saw when they cover less than the window', () => {
    expect(uptimeWords(ok({ source: 'edge-requests', coveredHours: 168, pct: 99.9, downMinutes: 10 })).basis).toBe(
      'the last 7 days, from the edges’ requests',
    );
  });

  it('has no figure without enough data', () => {
    const w = uptimeWords({ state: 'not-enough-data', pct: null, source: 'status-checks', windowDays: 30, coveredHours: 3, downMinutes: null });
    expect(w.figure).toBeNull();
    expect(w.basis).toBe('Not enough data for uptime yet');
    expect(w.tech).toBe('estate.uptime · 3 h seen from status checks, needs 24');
    expect(uptimeWords({ state: 'not-enough-data', pct: null, source: null, windowDays: 30, coveredHours: 0, downMinutes: null }).tech).toBe(
      'estate.uptime · 0 h seen, needs 24',
    );
  });
});

describe('pctWords / spanWords', () => {
  it('trims trailing zeros', () => {
    expect(pctWords(99.9)).toBe('99.9');
    expect(pctWords(100)).toBe('100');
    expect(pctWords(99.97)).toBe('99.97');
  });

  it('names the span', () => {
    expect(spanWords(700, 30)).toBe('30 days');
    expect(spanWords(30, 30)).toBe('the last day');
    expect(spanWords(170, 30)).toBe('the last 7 days');
  });
});
