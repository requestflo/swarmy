import { describe, expect, it } from 'bun:test';
import { MIRROR_NODE_LABEL, mirrorLabelKey, systemImage } from '@swarmy/core/system-images';
import { rewriteSystemImages, type MirrorState } from './system-images.service';

const H = 'localhost:5000';
const mirrored = (k: Parameters<typeof systemImage>[0]) => {
  const i = systemImage(k);
  return { [mirrorLabelKey(k)]: `${i.ref}@${i.digest}` };
};
const state: MirrorState = {
  labels: { ...mirrored('railpackFrontend'), ...mirrored('railpackBuilder'), ...mirrored('railpackPrepare'), [MIRROR_NODE_LABEL]: 'n1' },
  registryNodeId: 'n1',
  registry: undefined,
};
const build = { commandId: 'c', source: { url: 'u', ref: 'main' }, imageRefs: ['localhost:5000/a:main'] };

describe('rewriteSystemImages — Railpack images come from the cluster mirror', () => {
  it('fills the frontend, prepare image and mirrored plan images for railpack/auto builds', () => {
    const out = rewriteSystemImages('image.build', { ...build, builder: 'auto', railpack: { cacheKey: 'a' } }, H, state) as unknown as {
      railpack: { frontendImage: string; prepareImage: string; imageRewrites: Record<string, string>; cacheKey: string };
    };
    expect(out.railpack.cacheKey).toBe('a');
    expect(out.railpack.frontendImage).toBe(
      `${H}/swarmy-system/ghcr.io/railwayapp/railpack-frontend@${systemImage('railpackFrontend').digest}`,
    );
    expect(out.railpack.prepareImage).toBe(`${H}/swarmy-system/docker.io/library/bash@${systemImage('railpackPrepare').digest}`);
    const b = systemImage('railpackBuilder');
    const r = systemImage('railpackRuntime');
    expect(out.railpack.imageRewrites[b.ref]).toBe(`${H}/swarmy-system/ghcr.io/railwayapp/railpack-builder@${b.digest}`);
    // runtime isn't mirrored here → digest-pinned upstream
    expect(out.railpack.imageRewrites[r.ref]).toBe(`ghcr.io/railwayapp/railpack-runtime@${r.digest}`);
  });

  it('leaves Dockerfile builds and explicit overrides alone', () => {
    const df = { ...build, builder: 'dockerfile' };
    expect((rewriteSystemImages('image.build', df, H, state) as { railpack?: unknown }).railpack).toBeUndefined();
    const explicit = { ...build, builder: 'railpack', railpack: { frontendImage: 'x', prepareImage: 'y', imageRewrites: { a: 'b' } } };
    expect((rewriteSystemImages('image.build', explicit, H, state) as typeof explicit).railpack).toEqual(explicit.railpack);
  });
});
