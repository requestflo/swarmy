import { describe, expect, it } from 'bun:test';
import { DATA_IMAGES, dataImage } from '@swarmy/core/data-images';
import { buildPlatformManifest, manifestImages } from '@swarmy/core/platform-manifest';
import { MIRROR_NODE_LABEL, SYSTEM_IMAGES, mirrorLabelKey } from '@swarmy/core/system-images';
import { CACHE_IMAGES } from './cache.service';
import { resolveManagedPgImage } from './manageddb.service';
import { DRIFT_KEYS, planDrift } from './platform-drift';
import { SEARCH_IMAGES } from './search.service';
import { pinSystemImages, rewriteSystemImages, type MirrorState } from './system-images.service';
import { QDRANT_IMAGE } from './vector.service';

// The BOM's data section through the hub dispatch decorator: what a managed
// database, cache, search or vector instance actually deploys.
const D = (c: string) => `sha256:${c.repeat(64)}`;
const H = 'localhost:5000';
const release = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', tag: '1.3.0', digests: { postgres17: D('a'), redis: D('b') } });
const images = manifestImages(release);
const pg17 = dataImage('postgres17');
const deploy = (image: string) => ({ spec: { name: 'shop_main-primary', image } });

describe('managed data deploys through the BOM', () => {
  it('every managed service names a BOM data image', () => {
    const refs = new Set(DATA_IMAGES.map((i) => i.ref));
    for (const ref of [...Object.values(CACHE_IMAGES), ...Object.values(SEARCH_IMAGES), QDRANT_IMAGE, resolveManagedPgImage({})]) {
      expect(refs.has(ref)).toBe(true);
    }
  });

  it('at the release digest when the release pins one (tag kept), else by the tag', () => {
    expect(pinSystemImages('service.deploy', deploy(pg17.ref), images).spec.image).toBe(`pgvector/pgvector:pg17@${D('a')}`);
    expect(pinSystemImages('service.deploy', deploy('redis:7.4'), images).spec.image).toBe(`redis:7.4@${D('b')}`);
    expect(pinSystemImages('service.deploy', deploy('pgvector/pgvector:pg16'), images).spec.image).toBe('pgvector/pgvector:pg16');
    expect(pinSystemImages('service.deploy', deploy(pg17.ref), SYSTEM_IMAGES).spec.image).toBe(pg17.ref); // no release yet
  });

  it("from the built-in registry's copy once a bundle seeded it, tag kept", () => {
    const state: MirrorState = {
      labels: { [mirrorLabelKey('postgres17')]: `${pg17.ref}@${D('a')}`, [MIRROR_NODE_LABEL]: 'n1' },
      registryNodeId: 'n1',
      registry: undefined,
    };
    const mirrored = rewriteSystemImages('service.deploy', deploy(pg17.ref), H, state, images);
    expect(mirrored.spec.image).toBe(`localhost:5000/swarmy-system/docker.io/pgvector/pgvector:pg17@${D('a')}`);
    expect(pinSystemImages('service.deploy', mirrored, images)).toBe(mirrored);
    // …and a re-provision or a restore as a copy carries it back to the BOM ref.
    expect(resolveManagedPgImage({}, mirrored.spec.image)).toBe(pg17.ref);
    expect(resolveManagedPgImage({}, `pgvector/pgvector:pg16@${D('c')}`)).toBe('pgvector/pgvector:pg16');
  });

  it('a user-chosen version deploys the BOM ref for it', () => {
    expect(resolveManagedPgImage({ imageTag: '14' })).toBe(dataImage('postgres14').ref);
    expect(resolveManagedPgImage({ imageTag: '16' }, `pgvector/pgvector:pg17@${D('a')}`)).toBe('pgvector/pgvector:pg16');
  });
});

describe('the drift view never lists managed data', () => {
  it('no data image is a drift component', () => {
    for (const img of DATA_IMAGES) expect(DRIFT_KEYS[img.key]).toBeUndefined();
  });

  it('databases, caches and helpers on an older digest than the release are not drift', () => {
    const live = [
      { name: 'shop_main-primary', image: `pgvector/pgvector:pg17@${D('9')}` },
      { name: 'shop_cache', image: `redis:7.4@${D('8')}` },
      { name: 'swarmy-move-abc', image: 'alpine:3.20', labels: { 'swarmy.system': 'true' } },
      { name: 'swarmy-restic-check', image: 'restic/restic:0.16.4', labels: { 'swarmy.system': 'true' } },
    ];
    expect(planDrift(live, release.components)).toEqual([]);
  });
});
