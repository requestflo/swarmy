import { describe, expect, it } from 'bun:test';
import { buildStrategyPayload } from './cicd.service';

const base = { host: 'localhost:5000', imageName: 'shop', ref: 'main', defaultBranch: 'main' };

describe('buildStrategyPayload (image.build builder + registry cache)', () => {
  it('no swarmy.yaml build settings → auto + cache at the repo cache ref', () => {
    expect(buildStrategyPayload(base)).toEqual({
      builder: 'auto',
      railpack: { cacheKey: 'shop-root' },
      cache: { importRefs: ['localhost:5000/shop:buildcache-root-main'], exportRef: 'localhost:5000/shop:buildcache-root-main', mode: 'max' },
    });
  });

  it('railpack overrides + build env become Railpack options (env is NOT a build arg)', () => {
    const p = buildStrategyPayload({
      ...base,
      ref: 'pr-7',
      build: { builder: 'railpack', subdir: 'web', railpack: { startCmd: 'node server.js' }, env: { API: 'x' } },
    });
    expect(p.builder).toBe('railpack');
    expect(p.railpack).toMatchObject({ startCmd: 'node server.js', env: { API: 'x' } });
    expect(p.buildArgs).toBeUndefined();
    expect(p.cache.importRefs).toHaveLength(2);
    expect(p.cache.importRefs[1]).toMatch(/^localhost:5000\/shop:buildcache-web-[0-9a-f]{8}-main$/);
  });

  it('a Dockerfile build gets the build env as build args (explicit args win) and no Railpack options', () => {
    const p = buildStrategyPayload({ ...base, build: { builder: 'dockerfile', env: { A: '1', B: '2' }, buildArgs: { B: 'arg' } } });
    expect(p.railpack).toBeUndefined();
    expect(p.buildArgs).toEqual({ A: '1', B: 'arg' });
  });
});
