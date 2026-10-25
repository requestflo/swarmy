import { describe, expect, test } from 'bun:test';
import type { CertFacts } from './cert-facts-model';
import { renewalRows, renewalTech, renewsLine } from './cert-renewal-words';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const WINDOW = { renewAt: '2026-11-22T10:00:00.000Z', lifetimeDays: 90, state: 'ahead' as const, daysUntil: 29 };
const facts = (over: Partial<CertFacts> = {}): CertFacts => ({
  host: 'shop.northwind.dev',
  source: 'edges',
  reason: null,
  cert: null,
  edges: [],
  renewal: null,
  renewals: [],
  renew: { available: true },
  checkedAt: null,
  ...over,
});

describe('renewal, said', () => {
  test('the controller’s window when there is one; the expiry rule of thumb when not', () => {
    expect(renewsLine(facts({ renewal: WINDOW }), null, NOW)).toEqual({ text: 'renews itself in 29 days', tone: 'ok' });
    expect(renewsLine(facts({ renewal: { ...WINDOW, state: 'due', daysUntil: 0 } }), null, NOW)).toEqual({
      text: 'renewing now · the front door keeps trying until it lands',
      tone: 'info',
    });
    expect(renewsLine(facts({ renewal: { ...WINDOW, state: 'expired', daysUntil: 0 } }), null, NOW)).toBeNull();
    expect(renewsLine(null, '2026-12-22T12:00:00Z', NOW)).toEqual({ text: 'renews itself in 29 days', tone: 'ok' });
    expect(renewsLine(null, null, NOW)).toBeNull();
  });

  test('the rule at Controls says "around" and names ARI', () => {
    expect(renewalTech(facts({ renewal: WINDOW }))).toBe(
      "Caddy renews with a third of the lifetime left: around 22 Nov for this 90-day certificate · Let's Encrypt can suggest another moment (ARI), which Caddy follows",
    );
    expect(renewalTech(facts())).toBeNull();
  });

  test('renewals only as seen; none → no rows', () => {
    expect(renewalRows(facts())).toEqual([]);
    const seen = facts({ renewals: [{ at: '2026-09-23T10:00:00.000Z', issuer: "Let's Encrypt R11", replaced: '2026-06-25T10:00:00.000Z', by: 'automatic' }] });
    expect(renewalRows(seen)).toEqual([
      { when: '23 Sep', what: "renewed itself · Let's Encrypt R11", tech: 'notBefore 2026-09-23T10:00:00.000Z · replaced the one issued 2026-06-25T10:00:00.000Z' },
    ]);
  });
});
