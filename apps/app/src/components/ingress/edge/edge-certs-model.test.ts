import { describe, expect, it } from 'bun:test';
import { askThen, askTitle, askWhen, dayWords, issuanceWords, type AskDecision, type CertIssuance } from './edge-certs-model';

const NOW = Date.parse('2026-10-26T15:00:00Z');
const days = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, issued: 0 }));
const base: CertIssuance = { held: 6, local: 0, days, inWindow: 2, latestAt: '2026-10-26T09:00:00Z', reported: 2, edges: 2, source: 'edges' };

describe('issuanceWords', () => {
  it('says what the edges hold and how recent', () => {
    expect(issuanceWords(base, NOW)).toBe('6 held across the edges: 2 in the last 30 days, the newest today.');
    expect(issuanceWords({ ...base, inWindow: 0, latestAt: '2026-08-02T00:00:00Z' }, NOW)).toBe('6 held across the edges: none in the last 30 days, the newest 2 Aug.');
    expect(issuanceWords({ ...base, reported: 1 }, NOW)).toBe('6 held across the edges: 2 in the last 30 days, the newest today (1 of 2 edges answered).');
  });
  it('is honest when nothing can be said', () => {
    expect(issuanceWords({ ...base, source: 'no_edges' }, NOW)).toBe('No front door is running, so no edge holds a certificate.');
    expect(issuanceWords({ ...base, held: 0, inWindow: 0, latestAt: null }, NOW)).toBe('The edges hold no certificate yet: one is issued at an address’s first visit.');
  });
});

describe('dayWords', () => {
  it('reads like a person', () => {
    expect(dayWords('2026-10-25T23:00:00Z', NOW)).toBe('yesterday');
    expect(dayWords('2026-10-22T10:00:00Z', NOW)).toBe('4 days ago');
  });
});

const ask = (a: Partial<AskDecision>): AskDecision => ({ host: 'shop.acme.com', allowed: true, status: 200, why: 'routed', app: 'shop', at: '2026-10-26T10:31:00Z', count: 1, ...a });

describe('the ask log words', () => {
  it('says what each answer meant for the certificate', () => {
    expect(askThen(ask({}))).toBe('routed to shop, so the edge asks Let’s Encrypt');
    expect(askThen(ask({ why: 'dns-pending', app: 'shop' }))).toBe('its DNS doesn’t point at your edges yet, so no certificate');
    expect(askThen(ask({ why: 'unknown', app: null }))).toBe('not one of your addresses, so no certificate');
  });
  it('folds repeats into one line, and says the day when it isn’t today', () => {
    expect(askWhen(ask({ count: 14 }), NOW)).toMatch(/^×14, last \d\d:\d\d$/);
    expect(askWhen(ask({ at: '2026-10-25T10:31:00Z' }), NOW)).toMatch(/^yesterday \d\d:\d\d$/);
    expect(askWhen(ask({ at: '2026-10-23T10:31:00Z', count: 41 }), NOW)).toBe('×41, last 3 days ago');
  });
  it('titles the log by its refusals', () => {
    expect(askTitle([])).toBe('No edge has asked yet');
    expect(askTitle([ask({}), ask({})])).toBe('The last 2 asks were all allowed');
    expect(askTitle([ask({}), ask({ allowed: false, status: 403, why: 'unknown' })])).toBe('1 of the last 2 asks refused');
  });
});
