import { describe, expect, it } from 'bun:test';
import {
  CACHE_GC_GRACE_MS,
  buildCacheKey,
  buildCacheRefs,
  isCacheRef,
  parseCacheDeleted,
  parseCacheSizes,
  planCacheGc,
  renderCacheDeleteScript,
  renderCacheSizeScript,
} from './build-cache';

const GB = 1024 ** 3;
const now = new Date('2026-09-24T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe('build cache refs', () => {
  it('one key per build inputs; root for the default', () => {
    expect(buildCacheKey({})).toBe('root');
    expect(buildCacheKey({ subdir: '.', dockerfile: 'Dockerfile' })).toBe('root');
    const api = buildCacheKey({ subdir: 'services/api' });
    expect(api).toMatch(/^services-api-[0-9a-f]{8}$/);
    expect(buildCacheKey({ subdir: 'services/api', target: 'prod' })).not.toBe(api);
  });

  it('exports to the branch, imports the branch then the default branch', () => {
    expect(buildCacheRefs({ host: 'localhost:5000', imageName: 'shop', key: 'root', branch: 'feat/Login', defaultBranch: 'main' })).toEqual({
      exportRef: 'localhost:5000/shop:buildcache-root-feat-login',
      importRefs: ['localhost:5000/shop:buildcache-root-feat-login', 'localhost:5000/shop:buildcache-root-main'],
    });
    expect(buildCacheRefs({ host: 'h', imageName: 'shop', key: 'root', branch: 'main', defaultBranch: 'main' }).importRefs).toEqual([
      'h/shop:buildcache-root-main',
    ]);
  });

  it('recognises only cache tags (never an image tag or digest)', () => {
    expect(isCacheRef('localhost:5000/shop:buildcache-root-main')).toBe(true);
    expect(isCacheRef('localhost:5000/shop:main')).toBe(false);
    expect(isCacheRef('localhost:5000/shop@sha256:abc')).toBe(false);
    expect(isCacheRef('localhost:5000/buildcache-x/shop')).toBe(false);
  });
});

describe('planCacheGc (age/size policy)', () => {
  const policy = { maxAgeDays: 14, maxBytes: 3 * GB };

  it('drops stale refs by age, then the least recently written over budget', () => {
    const plan = planCacheGc(
      [
        { ref: 'a', lastWrittenAt: daysAgo(30), sizeBytes: 1 * GB },
        { ref: 'b', lastWrittenAt: daysAgo(2), sizeBytes: 2 * GB },
        { ref: 'c', lastWrittenAt: daysAgo(3), sizeBytes: 2 * GB },
        { ref: 'd', lastWrittenAt: daysAgo(5), sizeBytes: 0.5 * GB },
        { ref: 'gone', lastWrittenAt: daysAgo(4), sizeBytes: null },
      ],
      policy,
      now,
    );
    expect(plan.remove).toEqual([
      { ref: 'a', reason: 'age' },
      { ref: 'gone', reason: 'missing' },
      { ref: 'c', reason: 'size' },
    ]);
    expect(plan.keep).toEqual(['b', 'd']);
    expect(plan.keptBytes).toBe(2.5 * GB);
  });

  it('never removes a ref inside the grace window (an in-flight build may use it)', () => {
    const fresh = new Date(now.getTime() - CACHE_GC_GRACE_MS / 2);
    const plan = planCacheGc(
      [
        { ref: 'fresh-big', lastWrittenAt: fresh, sizeBytes: 10 * GB },
        { ref: 'fresh-missing', lastWrittenAt: fresh, sizeBytes: null },
      ],
      { maxAgeDays: 0, maxBytes: 0 },
      now,
    );
    expect(plan.remove).toEqual([]);
    expect(plan.keep.sort()).toEqual(['fresh-big', 'fresh-missing']);
  });
});

describe('regctl scripts', () => {
  it('size + delete scripts parse back; delete refuses non-cache refs', () => {
    const sizeScript = renderCacheSizeScript(['localhost:5000/shop:buildcache-root-main'], 'localhost:5000');
    expect(sizeScript).toContain(`regctl manifest get 'localhost:5000/shop:buildcache-root-main' --format raw-body`);
    expect(
      parseCacheSizes('@@SWARMY-CACHE-SIZE@@ h/a:buildcache-x 1234\n@@SWARMY-CACHE-SIZE@@ h/b:buildcache-y -\nnoise'),
    ).toEqual(new Map<string, number | null>([['h/a:buildcache-x', 1234], ['h/b:buildcache-y', null]]));
    const del = renderCacheDeleteScript(['h/a:buildcache-x', 'h/a:main', 'h/a@sha256:ff'], 'h');
    expect(del).toContain(`regctl tag delete 'h/a:buildcache-x'`);
    expect(del).not.toContain(`'h/a:main'`);
    expect(del).not.toContain('sha256:ff');
    expect(parseCacheDeleted('@@SWARMY-CACHE-DELETED@@ h/a:buildcache-x\n')).toEqual(['h/a:buildcache-x']);
  });
});
