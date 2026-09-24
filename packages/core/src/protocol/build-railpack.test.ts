import { describe, expect, it } from 'bun:test';
import { ControllerToAgentMessage } from './messages';
import { BuildImagePayload } from './build';

/** `buildImage.builder/railpack/cache` (additive): zero-config builds + registry cache. */
describe('BuildImagePayload railpack + cache round-trip', () => {
  const base = {
    commandId: '11111111-2222-3333-4444-555555555555',
    source: { url: 'https://github.com/o/r', ref: 'main' },
    imageRefs: ['localhost:5000/r:main'],
    builder: 'auto',
    railpack: {
      installCmd: 'npm ci',
      buildCmd: 'npm run build',
      startCmd: 'node dist/index.js',
      packages: ['node@22'],
      deployAptPackages: ['ffmpeg'],
      env: { NEXT_PUBLIC_API: 'https://api.example.com' },
      cacheKey: 'r',
    },
    cache: { importRefs: ['localhost:5000/r:buildcache-root-main'], exportRef: 'localhost:5000/r:buildcache-root-main' },
  };

  it('survives the wire inside the discriminated union', () => {
    const parsed = ControllerToAgentMessage.parse(JSON.parse(JSON.stringify({ type: 'buildImage', payload: base })));
    if (parsed.type !== 'buildImage') throw new Error('wrong type');
    expect(parsed.payload.builder).toBe('auto');
    expect(parsed.payload.railpack?.env).toEqual({ NEXT_PUBLIC_API: 'https://api.example.com' });
    expect(parsed.payload.cache?.mode).toBe('max');
  });

  it('an old payload (no builder) still parses and stays a Dockerfile build', () => {
    const { builder: _b, railpack: _r, cache: _c, ...old } = base;
    const p = BuildImagePayload.parse(old);
    expect(p.builder).toBeUndefined();
  });

  it('rejects env names that would reach a shell', () => {
    expect(BuildImagePayload.safeParse({ ...base, railpack: { env: { 'A;rm': 'x' } } }).success).toBe(false);
    expect(BuildImagePayload.safeParse({ ...base, railpack: { cacheKey: 'a b' } }).success).toBe(false);
    expect(BuildImagePayload.safeParse({ ...base, builder: 'nixpacks' }).success).toBe(false);
  });
});
