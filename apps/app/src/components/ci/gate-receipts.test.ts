import { describe, expect, test } from 'bun:test';
import { SCAN_LIMIT, gateReceipts, shortRef, type DecisionLike, type ScanLike } from './gate-receipts';

const now = Date.parse('2026-10-24T12:00:00Z');
const daysAgo = (d: number): string => new Date(now - d * 86_400_000).toISOString();
const scan = (imageRef: string, criticalCount: number, d: number, status = criticalCount ? 'failed' : 'passed'): ScanLike => ({
  imageRef, criticalCount, highCount: criticalCount ? 1 : 0, status, scannedAt: daysAgo(d),
});

describe('gateReceipts', () => {
  test('the CVE gate refuses on the newest scan of each image, inside 30 days', () => {
    const r = gateReceipts(
      [scan('localhost:5000/web:2', 0, 1), scan('localhost:5000/web:1', 2, 2), scan('localhost:5000/web:2', 3, 3), scan('localhost:5000/old:1', 5, 40)],
      [],
      now,
    );
    expect(r.scans).toBe(3);
    expect(r.withCritical).toBe(2);
    expect(r.criticalImages).toEqual([{ ref: 'localhost:5000/web:1', critical: 2 }]);
    expect(r.scansCapped).toBe(false);
  });

  test('overrides are sorted by the image rule they went past; blocked rows and old rows are not', () => {
    const d = (at: number, kind: DecisionLike['kind'], rule: string): DecisionLike => ({ at: daysAgo(at), kind, stack: 'shop', violations: [{ rule }] });
    const r = gateReceipts([], [d(1, 'overridden', 'images/critical-cves'), d(2, 'overridden', 'images/unsigned'), d(3, 'blocked', 'images/unsigned'), d(45, 'overridden', 'images/unsigned')], now);
    expect(r.overrides.cve).toHaveLength(1);
    expect(r.overrides.unsigned).toHaveLength(1);
  });

  test('a full page of scans inside the window is a floor', () => {
    expect(gateReceipts(Array.from({ length: SCAN_LIMIT }, () => scan('localhost:5000/a:1', 0, 1)), [], now).scansCapped).toBe(true);
  });

  test('shortRef drops the registry host and shortens a digest', () => {
    expect(shortRef('localhost:5000/northwind-web:1.8.2')).toBe('northwind-web:1.8.2');
    expect(shortRef(`localhost:5000/api@sha256:${'ab12cd34'.repeat(8)}`)).toBe('api@ab12cd34…');
  });
});
