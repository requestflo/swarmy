import { describe, expect, it } from 'bun:test';
import { MINUTE_MS } from './edge-traffic';
import {
  TRAFFIC_HOUR_MS,
  firstHourToFold,
  foldTrafficHours,
  hoursToFold,
  type StoredTrafficRollup,
} from './edge-traffic-hourly';

const H0 = Date.UTC(2026, 9, 19, 10);
const B = [0.01, 0.1, 1];
const lat = (i: number, n: number) => ({ bounds: B, counts: [0, 0, 0, 0].map((_, k) => (k === i ? n : 0)) });

function row(min: number, over: Partial<StoredTrafficRollup> = {}): StoredTrafficRollup {
  return { bucketStart: H0 + min * MINUTE_MS, nodeId: 'eu1', host: 'shop.example.com', region: 'eu', app: 'shop', requests: 10, errors5xx: 0, ...over };
}

describe('foldTrafficHours — one row per (hour, edge, host)', () => {
  it('adds an hour of 5-minute counts and keeps edges, hosts and hours apart', () => {
    const rows = [
      row(0, { requests: 100, errors5xx: 1 }),
      row(5, { requests: 200, errors5xx: 2 }),
      row(55, { requests: 300 }),
      row(60, { requests: 7 }),
      row(0, { nodeId: 'us1', requests: 50 }),
      row(0, { host: '', app: null, requests: 0 }),
    ];
    expect(foldTrafficHours(rows).map((r) => [r.bucketStart - H0, r.nodeId, r.host, r.requests, r.errors5xx])).toEqual([
      [0, 'eu1', '', 0, 0],
      [0, 'eu1', 'shop.example.com', 600, 3],
      [0, 'us1', 'shop.example.com', 50, 0],
      [TRAFFIC_HOUR_MS, 'eu1', 'shop.example.com', 7, 0],
    ]);
  });

  it('merges duration buckets and blocked answers; unreported stays unreported', () => {
    const [folded] = foldTrafficHours([
      row(0, { status403: 4, status429: 1, latency: lat(0, 10) }),
      row(5, { latency: lat(2, 5) }),
      row(10, { status403: 2 }),
    ]);
    expect(folded).toMatchObject({ status403: 6, status429: 1, latency: { bounds: B, counts: [10, 0, 5, 0] } });
    expect(foldTrafficHours([row(0)])[0]!.status403).toBeUndefined();
  });

  it("takes region and app from the hour's newest row, whatever the input order", () => {
    const rows = [row(50, { app: 'store', region: 'eu-west' }), row(0, { app: null, region: null })];
    expect(foldTrafficHours(rows)[0]).toMatchObject({ app: 'store', region: 'eu-west', requests: 20 });
  });

  it('is the same fold twice: refolding an hour writes the same numbers (upsert-safe)', () => {
    const rows = [row(0), row(5, { latency: lat(1, 3) }), row(0, { host: '' })];
    expect(foldTrafficHours(rows)).toEqual(foldTrafficHours([...rows].reverse()));
  });
});

describe('hoursToFold — only hours whose 5-minute rows are all flushed', () => {
  it('stops at the flush watermark and never folds the hour still filling', () => {
    expect(hoursToFold(H0, H0 + TRAFFIC_HOUR_MS + 55 * MINUTE_MS)).toEqual([H0]);
    expect(hoursToFold(H0, H0 + 2 * TRAFFIC_HOUR_MS)).toEqual([H0, H0 + TRAFFIC_HOUR_MS]);
    expect(hoursToFold(H0, H0 + 59 * MINUTE_MS)).toEqual([]);
  });

  it('caps a backfill per tick, oldest first', () => {
    const hours = hoursToFold(H0, H0 + 100 * TRAFFIC_HOUR_MS, 3);
    expect(hours).toEqual([H0, H0 + TRAFFIC_HOUR_MS, H0 + 2 * TRAFFIC_HOUR_MS]);
  });
});

describe('firstHourToFold — where a restarted worker picks up', () => {
  it('after the newest folded hour, else the first whole hour of 5-minute rows, else the boot hour', () => {
    expect(firstHourToFold({ newestFolded: H0, oldestRollup: H0 - 99 * TRAFFIC_HOUR_MS, boot: H0 })).toBe(H0 + TRAFFIC_HOUR_MS);
    expect(firstHourToFold({ newestFolded: null, oldestRollup: H0 + 25 * MINUTE_MS, boot: H0 + 5 * TRAFFIC_HOUR_MS })).toBe(H0 + TRAFFIC_HOUR_MS);
    expect(firstHourToFold({ newestFolded: null, oldestRollup: H0, boot: H0 + 5 * TRAFFIC_HOUR_MS })).toBe(H0);
    expect(firstHourToFold({ newestFolded: null, oldestRollup: null, boot: H0 + 42 * MINUTE_MS })).toBe(H0);
  });
});
