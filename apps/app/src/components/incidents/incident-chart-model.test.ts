import { describe, expect, test } from 'bun:test';
import type { ReleaseView } from '@swarmy/core';
import { bucketTime, formatValue, linePath, releaseMarkers, seriesFor, valueTone } from './incident-chart-model';

const rows = [
  { bucket: '2026-09-26 17:00:00', calls: 1000, errors: 3, p95_ms: 420 },
  { bucket: '2026-09-26 17:05:00', calls: 0, errors: 0, p95_ms: 0 },
  { bucket: '2026-09-26 17:10:00', calls: 1000, errors: 61, p95_ms: 9800 },
];

describe('incident chart model', () => {
  test('error share per bucket, skipping empty buckets (a gap, not a zero)', () => {
    const s = seriesFor('errors', rows);
    expect(s.map((p) => p.v)).toEqual([0.3, 6.1]);
    expect(s[0]!.t).toBe(bucketTime('2026-09-26 17:00:00'));
    expect(seriesFor('latency', rows).map((p) => p.v)).toEqual([420, 9800]);
  });

  test('values and tones', () => {
    expect(formatValue('errors', 6.1)).toBe('6.1%');
    expect(formatValue('errors', 12.4)).toBe('12%');
    expect(formatValue('latency', 9800)).toBe('9.8 s');
    expect(valueTone('errors', 6.1)).toBe('bad');
    expect(valueTone('errors', 2.5)).toBe('warn');
    expect(valueTone('latency', 420)).toBe('ok');
  });

  test('a marker per release inside the window', () => {
    const at = Date.parse('2026-09-26T17:05:00Z');
    const rel = (createdAt: string, tag: string): ReleaseView => ({
      id: tag, stackName: 's', status: 'healthy', images: [{ name: 'w', image: `w:${tag}` }], actor: null, strategy: null, healthGate: null, notes: null, createdAt,
    });
    const m = releaseMarkers([rel(new Date(at).toISOString(), '1.9.0'), rel('2026-09-20T10:00:00Z', '1.8.0')], at - 3_600_000, at + 60_000);
    expect(m).toHaveLength(1);
    expect(m[0]!.label).toMatch(/^\d\d:\d\d deploy 1\.9\.0$/);
  });

  test('the line spans the box', () => {
    expect(linePath([{ t: 0, v: 0 }, { t: 10, v: 5 }], 0, 10, 10, 100, 50)).toBe('M0.0 50.0 L100.0 25.0');
  });
});
