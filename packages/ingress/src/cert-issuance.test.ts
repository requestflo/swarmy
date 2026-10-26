import { describe, expect, it } from 'bun:test';
import type { EdgeCertFact } from '@swarmy/core/protocol';
import { certIssuance } from './cert-issuance';
import type { EdgeCertRead } from './edge-certs';

const NOW = Date.parse('2026-10-26T15:00:00Z');

function cert(name: string, notBefore: string, fp: string, issuerKey = 'acme-v02.api.letsencrypt.org-directory'): EdgeCertFact {
  return { name, issuerKey, issuer: "Let's Encrypt R11", notBefore, notAfter: '2027-01-01T00:00:00Z', names: [name], serial: fp, fingerprint256: fp };
}

const read = (nodeId: string, certs: EdgeCertFact[]): EdgeCertRead => ({ nodeId, status: 'read', certs, checkedAt: '2026-10-26T15:00:00Z' });

describe('certIssuance', () => {
  it('counts each certificate once, however many edges hold it, on the day it was issued', () => {
    const shop = cert('shop.example.com', '2026-10-26T09:12:00Z', 'AA');
    const api = cert('api.example.com', '2026-10-24T22:00:00Z', 'BB');
    const old = cert('old.example.com', '2026-08-01T10:00:00Z', 'CC');
    const r = certIssuance([read('eu1', [shop, api, old]), read('us1', [shop, api])], NOW);
    expect(r.held).toBe(3);
    expect(r.inWindow).toBe(2);
    expect(r.days).toHaveLength(30);
    expect(r.days.at(-1)).toEqual({ day: '2026-10-26', issued: 1 });
    expect(r.days.at(-3)).toEqual({ day: '2026-10-24', issued: 1 });
    expect(r.days[0]!.day).toBe('2026-09-27');
    expect(r.latestAt).toBe('2026-10-26T09:12:00.000Z');
    expect(r.reported).toBe(2);
  });

  it('an edge’s older copy not synced yet is its own issuance', () => {
    const r = certIssuance([read('eu1', [cert('shop.example.com', '2026-10-26T09:00:00Z', 'NEW')]), read('us1', [cert('shop.example.com', '2026-08-30T09:00:00Z', 'OLD')])], NOW);
    expect(r.held).toBe(2);
    expect(r.inWindow).toBe(1);
  });

  it('tells the edge’s own authority apart, and edges that could not say', () => {
    const lan = cert('app.192-168-1-5.sslip.io', '2026-10-20T00:00:00Z', 'LL', 'local');
    const r = certIssuance([read('eu1', [lan]), { nodeId: 'us1', status: 'not_reported', reason: 'agent predates it' }], NOW);
    expect(r.local).toBe(1);
    expect(r.reported).toBe(1);
    expect(r.edges).toBe(2);
  });

  it('is empty and honest with no edge', () => {
    const r = certIssuance([], NOW);
    expect(r.held).toBe(0);
    expect(r.latestAt).toBeNull();
    expect(r.days.every((d) => d.issued === 0)).toBe(true);
  });
});
