import { describe, expect, it } from 'bun:test';
import { MIRROR_NODE_LABEL, mirrorLabelKey, pinnedSystemRef, railpackImageRewrites, systemImage } from './system-images';

describe('railpack images', () => {
  it('pins the plan base images to digests when nothing is mirrored', () => {
    expect(railpackImageRewrites()).toEqual({
      'ghcr.io/railwayapp/railpack-builder:mise-2026.9.12':
        'ghcr.io/railwayapp/railpack-builder@sha256:a104c45734b7c59fa7f52ab5afac87c3a4dfa5ee1c5495ae0c798756c670c865',
      'ghcr.io/railwayapp/railpack-runtime:mise-2026.9.12':
        'ghcr.io/railwayapp/railpack-runtime@sha256:b699280f7b492ddba483ee1d03badaae238b8846ff2ef1e71ad8a2fd637c25b5',
    });
    expect(pinnedSystemRef('railpackFrontend')).toBe(
      'ghcr.io/railwayapp/railpack-frontend@sha256:fc6d5fa434c9310500dc18bebb0a4eb4854fee8546a6d7a090e7a36e39d9d153',
    );
  });

  it('uses the mirrored copy when it is trusted', () => {
    const img = systemImage('railpackBuilder');
    const labels = { [mirrorLabelKey('railpackBuilder')]: `${img.ref}@${img.digest}`, [MIRROR_NODE_LABEL]: 'n1' };
    const out = railpackImageRewrites({ registryHost: 'localhost:5000', labels, registryNodeId: 'n1' });
    expect(out[img.ref]).toBe(`localhost:5000/swarmy-system/ghcr.io/railwayapp/railpack-builder@${img.digest}`);
    // runtime not mirrored → pinned upstream
    expect(out['ghcr.io/railwayapp/railpack-runtime:mise-2026.9.12']).toStartWith('ghcr.io/railwayapp/railpack-runtime@sha256:');
    // registry moved node → not trusted
    expect(railpackImageRewrites({ registryHost: 'localhost:5000', labels, registryNodeId: 'n2' })[img.ref]).toStartWith('ghcr.io/');
  });
});
