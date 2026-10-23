import { describe, expect, test } from 'bun:test';
import { composeItem } from './compose-item';
import { buildClusters, clusterTone, clusterTotal, servicesPerApp } from './data-board-model';
import { bucketItem, cacheItem, storeCount, type DataItem } from './estate-data';

const GB = 1024 ** 3;
const cache = cacheItem({ stack: 'storefront', name: 'main', engine: 'valkey', memoryMb: 512, replicas: { desired: 2, running: 2 } });
const media = bucketItem({ id: 'b1', name: 'media', usageBytes: 18.4 * GB, objects: 12_431 }, 'storefront', 3);
const spare = bucketItem({ id: 'b2', name: 'spare', usageBytes: 0, objects: 0 }, 'Shared', 3);
const warn: DataItem = { ...cache, key: 'x', tone: 'warn' };

describe('clusterTotal', () => {
  test('counts stores and buckets, with the bytes buckets hold', () => {
    expect(clusterTotal([cache, media])).toBe('1 store and 1 bucket · 18.4 GB of files');
    expect(clusterTotal([cache])).toBe('1 store');
    expect(clusterTotal([])).toBe('nothing kept yet');
  });
  test('compose databases are said apart from the Data tab count', () => {
    const my = composeItem('blog', { name: 'blog_mysql', engine: 'mysql', image: 'mysql:8', running: true });
    expect(storeCount([cache, my])).toBe('1 store · 1 from compose');
    expect(my.badge).toBe('MY');
  });
});

test('clusterTone takes the worst', () => {
  expect(clusterTone([cache, warn])).toBe('warn');
  expect(clusterTone([])).toBe('ok');
});

describe('buildClusters', () => {
  test('every app is a cluster, even an empty one; unattached buckets go last', () => {
    const c = buildClusters([media, cache, spare], ['storefront', 'blog'], new Map([['storefront', 4]]));
    expect(c.map((x) => [x.app, x.items.length, x.droppable, x.services])).toEqual([
      ['blog', 0, true, undefined],
      ['storefront', 2, true, 4],
      ['Shared', 1, false, undefined],
    ]);
    expect(c[2]!.label).toBe('Not attached to an app');
  });
  test('no unattached buckets, no Shared cluster', () => {
    expect(buildClusters([cache], ['storefront'], undefined).map((x) => x.app)).toEqual(['storefront']);
  });
});

test('servicesPerApp skips swarmy’s own services', () => {
  const m = servicesPerApp([{ stack: 'storefront' }, { stack: 'storefront' }, { stack: 'swarmy-system' }], ['swarmy-system']);
  expect([...m]).toEqual([['storefront', 2]]);
});
