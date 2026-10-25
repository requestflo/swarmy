import { describe, expect, test } from 'bun:test';
import { caaLine, caaTech, type CaaFacts } from './caa-words';

const v = (over: Partial<CaaFacts> = {}): CaaFacts => ({
  host: 'shop.northwind.dev',
  ca: { name: "Let's Encrypt", caa: 'letsencrypt.org' },
  state: 'allowed',
  at: 'northwind.dev',
  allowed: ['letsencrypt.org'],
  records: [{ critical: 0, tag: 'issue', value: 'letsencrypt.org' }],
  caveats: [],
  say: "CAA at northwind.dev lets Let's Encrypt issue (letsencrypt.org allowed).",
  asked: ['shop.northwind.dev', 'northwind.dev'],
  checkedAt: '2026-10-24T12:00:00.000Z',
  ...over,
});

describe('CAA, said', () => {
  test('allowed reads as the board does; caveats turn it amber', () => {
    expect(caaLine(v())).toEqual({ text: 'letsencrypt.org allowed', tone: 'ok', note: null });
    expect(caaLine(v({ caveats: ['only the ACME account x may issue'] }))).toEqual({ text: 'letsencrypt.org allowed', tone: 'warn', note: 'Allowed, but only the ACME account x may issue.' });
  });

  test('no records is allowed too; forbidden and unknown say why', () => {
    expect(caaLine(v({ state: 'open', at: null, records: [] }))?.text).toBe('letsencrypt.org allowed');
    expect(caaLine(v({ state: 'forbidden', say: 'CAA at northwind.dev allows only sectigo.com.' }))).toEqual({ text: "Let's Encrypt not allowed", tone: 'bad', note: 'CAA at northwind.dev allows only sectigo.com.' });
    expect(caaLine(v({ state: 'unknown', say: 'The lookup failed.' }))?.tone).toBe('warn');
    expect(caaLine(null)).toBeNull();
  });

  test('the Controls line: where, what was asked, the records as written', () => {
    expect(caaTech(v())).toBe('CAA at northwind.dev · asked shop.northwind.dev → northwind.dev · 0 issue "letsencrypt.org"');
    expect(caaTech(v({ state: 'open', at: null, records: [], asked: ['a.dev', 'dev'] }))).toBe('CAA none found · asked a.dev → dev');
  });
});
