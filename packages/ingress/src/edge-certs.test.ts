import { describe, expect, it } from 'bun:test';
import type { EdgeCertFact } from '@swarmy/core/protocol';
import { hostCertFacts, nameCovers, type EdgeCertRead } from './edge-certs';

const LE = 'acme-v02.api.letsencrypt.org-directory';
function cert(name: string, names: string[], notAfter: string, fp = name + notAfter): EdgeCertFact {
  return { name, issuerKey: LE, issuer: "Let's Encrypt R11", notBefore: '2026-09-23T10:00:00.000Z', notAfter, names, serial: '01', fingerprint256: fp };
}
const read = (nodeId: string, certs: EdgeCertFact[]): EdgeCertRead => ({ nodeId, status: 'read', certs, checkedAt: '2026-10-24T12:00:00.000Z' });

const SHOP = cert('shop.northwind.dev', ['shop.northwind.dev', 'www.shop.northwind.dev'], '2026-12-22T10:00:00.000Z');
const WILD = cert('wildcard_.northwind.dev', ['*.northwind.dev', 'northwind.dev'], '2027-01-30T00:00:00.000Z');

describe('nameCovers', () => {
  it('exact (case and trailing dot ignored), or a wildcard exactly one label up', () => {
    expect(nameCovers('Shop.Northwind.dev.', 'shop.northwind.dev')).toBe(true);
    expect(nameCovers('*.northwind.dev', 'shop.northwind.dev')).toBe(true);
    expect(nameCovers('*.northwind.dev', 'a.shop.northwind.dev')).toBe(false);
    expect(nameCovers('*.northwind.dev', 'northwind.dev')).toBe(false);
    expect(nameCovers('northwind.dev', 'shop.northwind.dev')).toBe(false);
  });
});

describe('hostCertFacts', () => {
  it('exact beats a newer wildcard, as Caddy picks; both edges hold it', () => {
    const f = hostCertFacts('shop.northwind.dev', [read('n1', [SHOP, WILD]), read('n2', [SHOP])]);
    expect(f.cert?.name).toBe('shop.northwind.dev');
    expect(f.cert?.wildcard).toBeNull();
    expect(f.edges).toEqual([{ nodeId: 'n1', state: 'holds' }, { nodeId: 'n2', state: 'holds' }]);
    expect(f.reported).toBe(2);
  });

  it('a host only a wildcard covers says which wildcard', () => {
    const f = hostCertFacts('api.northwind.dev', [read('n1', [SHOP, WILD])]);
    expect(f.cert?.name).toBe('wildcard_.northwind.dev');
    expect(f.cert?.wildcard).toBe('*.northwind.dev');
  });

  it('an edge with an older copy, one with none, an old agent and a failed read', () => {
    const old = cert('shop.northwind.dev', SHOP.names, '2026-09-30T10:00:00.000Z');
    const f = hostCertFacts('shop.northwind.dev', [
      read('n1', [SHOP]),
      read('n2', [old]),
      read('n3', []),
      { nodeId: 'n4', status: 'not_reported', reason: 'agent 1.4.0 predates edgeCerts' },
      { nodeId: 'n5', status: 'error', reason: 'timed out' },
    ]);
    expect(f.cert?.notAfter).toBe(SHOP.notAfter);
    expect(f.edges.map((e) => e.state)).toEqual(['holds', 'other', 'missing', 'not_reported', 'error']);
    expect(f.reported).toBe(3);
  });

  it('nothing reported → no certificate, never a guess', () => {
    const f = hostCertFacts('shop.northwind.dev', [{ nodeId: 'n1', status: 'not_reported', reason: 'old agent' }]);
    expect(f).toEqual({ host: 'shop.northwind.dev', cert: null, edges: [{ nodeId: 'n1', state: 'not_reported', reason: 'old agent' }], reported: 0 });
  });
});
