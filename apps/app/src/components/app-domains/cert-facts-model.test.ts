import { describe, expect, test } from 'bun:test';
import { coversLine, factsTech, issuedLine, servedBy, type CertFacts } from './cert-facts-model';

const CERT = {
  issuer: "Let's Encrypt R11",
  issuerKey: 'acme-v02.api.letsencrypt.org-directory',
  notBefore: '2026-09-23T10:00:00.000Z',
  notAfter: '2026-12-22T10:00:00.000Z',
  names: ['shop.northwind.dev', 'www.shop.northwind.dev'],
  wildcard: null,
  serial: '04A1',
};
const facts = (over: Partial<CertFacts> = {}): CertFacts => ({
  host: 'shop.northwind.dev',
  source: 'edges',
  reason: null,
  cert: CERT,
  edges: [
    { nodeId: 'n1', name: 'london-1', state: 'holds', reason: null },
    { nodeId: 'n2', name: 'new-york-1', state: 'other', reason: null },
    { nodeId: 'n3', name: 'tokyo-1', state: 'not_reported', reason: 'old agent' },
  ],
  renewal: null,
  renewals: [],
  renew: { available: true },
  checkedAt: '2026-10-24T12:00:00.000Z',
  ...over,
});

describe('certificate facts, said', () => {
  test('issued and expiry, the issue year only when it differs', () => {
    expect(issuedLine(CERT.notBefore, CERT.notAfter)).toBe('issued 23 Sep · expires 22 Dec 2026');
    expect(issuedLine('2026-11-20T00:00:00Z', '2027-02-18T00:00:00Z')).toBe('issued 20 Nov 2026 · expires 18 Feb 2027');
  });

  test('covers: this address first, or the wildcard that covers it', () => {
    expect(coversLine(CERT, 'shop.northwind.dev')).toEqual({ names: 'shop.northwind.dev · www.shop.northwind.dev', note: null });
    expect(coversLine({ names: ['*.northwind.dev', 'northwind.dev'], wildcard: '*.northwind.dev' }, 'api.northwind.dev')).toEqual({
      names: '*.northwind.dev',
      note: 'a wildcard: every address one level under northwind.dev, api.northwind.dev included',
    });
  });

  test('served by: the edges’ own storage when they reported, else the TLS probe', () => {
    expect(servedBy(facts(), [], (ip) => ip)).toEqual([
      { key: 'n1', name: 'london-1', ok: true, note: null },
      { key: 'n2', name: 'new-york-1', ok: false, note: 'an older copy' },
      { key: 'n3', name: 'tokyo-1', ok: false, note: 'not reported' },
    ]);
    const probed = [{ ip: '203.0.113.10', ok: true }, { ip: '203.0.113.11', ok: false }];
    expect(servedBy(facts({ source: 'not_reported', cert: null, edges: [] }), probed, (ip) => (ip.endsWith('10') ? 'mgr-1' : ip))).toEqual([
      { key: '203.0.113.10', name: 'mgr-1', ok: true, note: null },
      { key: '203.0.113.11', name: '203.0.113.11', ok: false, note: 'not yet' },
    ]);
  });

  test('the Controls line names the storage, never a key', () => {
    expect(factsTech(facts())).toBe(
      "read from each edge's Caddy storage (acme-v02.api.letsencrypt.org-directory/…/*.crt, never a key) · serial 04A1 · notBefore 2026-09-23T10:00:00.000Z · notAfter 2026-12-22T10:00:00.000Z",
    );
    expect(factsTech(facts({ source: 'not_reported', cert: null, reason: 'Not reported: old agent.' }))).toBe('edge storage · Not reported: old agent.');
    expect(factsTech(null)).toBeNull();
  });
});
