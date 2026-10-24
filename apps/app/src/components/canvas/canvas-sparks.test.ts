import { describe, expect, test } from 'bun:test';
import type { InvService } from '@swarmy/core';
import { serviceSparks, sparkNames, sparkValues } from './canvas-sparks';

const svc = (name: string, env: string[] = []): InvService => ({ id: name, name, env, labels: {} }) as unknown as InvService;
/** ClickHouse's bucket string for an epoch ms (UTC). */
const at = (t: number): string => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const STEP = 120_000;
const NOW = Date.UTC(2026, 9, 24, 10, 0, 30);
const LAST = Math.floor(NOW / STEP) * STEP;

describe('sparkNames', () => {
  test('asks for each name a part may send spans as, once', () => {
    expect(sparkNames('shop', [svc('shop_web', ['OTEL_SERVICE_NAME=shop-web']), svc('shop_api')])).toEqual(['shop-web', 'shop_web', 'web', 'shop_api', 'api']);
  });
});

describe('sparkValues', () => {
  test('thirty two-minute buckets ending now; a gap before the first span, real zeros after', () => {
    const v = sparkValues([{ bucket: at(LAST - 2 * STEP), calls: 5 }, { bucket: at(LAST), calls: 7 }], NOW);
    expect(v).toHaveLength(30);
    expect(v.slice(0, 27).every((x) => x === null)).toBe(true);
    expect(v.slice(27)).toEqual([5, 0, 7]);
  });

  test('points outside the window are ignored; none known stays all gaps', () => {
    expect(sparkValues([{ bucket: at(LAST - 40 * STEP), calls: 9 }], NOW).every((x) => x === null)).toBe(true);
  });
});

describe('serviceSparks', () => {
  test('a part takes the first of its names that has spans, keyed by short name', () => {
    const parts = [svc('shop_web', ['OTEL_SERVICE_NAME=shop-web']), svc('shop_api'), svc('shop_worker')];
    const series = [
      { service: 'shop-web', points: [{ bucket: at(LAST), calls: 4 }] },
      { service: 'api', points: [{ bucket: at(LAST), calls: 2 }] },
      { service: 'shop_worker', points: [] },
    ];
    const out = serviceSparks('shop', parts, series, NOW);
    expect([...out.keys()]).toEqual(['web', 'api']);
    expect(out.get('web')?.at(-1)).toBe(4);
    expect(out.get('api')?.at(-1)).toBe(2);
  });
});
