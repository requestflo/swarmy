import { describe, expect, it } from 'bun:test';
import {
  imageDigests,
  normalizeDigest,
  selectImagesToPrune,
  type RawImage,
} from './prune';

const PROD = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const OLD = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

function img(over: Partial<RawImage>): RawImage {
  return { Id: 'sha256:deadbeef', Size: 100, Created: 1_700_000_000, ...over };
}

describe('image-ref parsing', () => {
  it('normalizeDigest strips a repo@ prefix', () => {
    expect(normalizeDigest(`registry:5000/app@${PROD}`)).toBe(PROD);
    expect(normalizeDigest(PROD)).toBe(PROD);
  });

  it('imageDigests pulls every digest from RepoDigests + a sha256 Id', () => {
    const d = imageDigests(
      img({ Id: PROD, RepoDigests: [`registry:5000/app@${OLD}`, `mirror/app@${OLD}`] }),
    );
    expect(d).toContain(PROD);
    expect(d).toContain(OLD);
    // de-duped
    expect(d.filter((x) => x === OLD).length).toBe(1);
  });

  it('imageDigests tolerates missing RepoDigests / non-sha Id', () => {
    expect(imageDigests(img({ Id: 'localhost/x:tag', RepoDigests: null }))).toEqual([]);
  });
});

describe('selectImagesToPrune — keep set + scope', () => {
  it('never removes an image whose digest is in keepDigests (in-prod pin)', () => {
    const images = [
      img({ Id: 'i-prod', RepoTags: ['registry:5000/app:prod'], RepoDigests: [`registry:5000/app@${PROD}`] }),
      img({ Id: 'i-old', RepoTags: ['registry:5000/app:old'], RepoDigests: [`registry:5000/app@${OLD}`] }),
    ];
    const { remove, keep } = selectImagesToPrune(images, {
      keepDigests: [PROD],
      repoPrefix: 'registry:5000/',
      strategy: 'all-except-keep',
    });
    expect(remove.map((r) => r.id)).toEqual(['i-old']);
    expect(keep.map((k) => k.id)).toContain('i-prod');
  });

  it('keeps images outside repoPrefix scope (base/operator images untouched)', () => {
    const images = [
      img({ Id: 'i-base', RepoTags: ['node:20'], RepoDigests: ['docker.io/library/node@' + OLD] }),
      img({ Id: 'i-app', RepoTags: ['registry:5000/app:x'], RepoDigests: [`registry:5000/app@${OLD}`] }),
    ];
    const { remove, keep } = selectImagesToPrune(images, {
      keepDigests: [],
      repoPrefix: 'registry:5000/',
      strategy: 'all-except-keep',
    });
    expect(remove.map((r) => r.id)).toEqual(['i-app']);
    expect(keep.map((k) => k.id)).toContain('i-base');
  });

  it('until strategy removes images older than the window, keeps pinned', () => {
    const now = new Date('2026-06-27T00:00:00.000Z').getTime();
    const oldCreated = Math.floor((now - 40 * 24 * 3600 * 1000) / 1000);
    const newCreated = Math.floor((now - 1 * 24 * 3600 * 1000) / 1000);
    const images = [
      img({ Id: 'i-old', Created: oldCreated, RepoTags: ['registry:5000/app:o'], RepoDigests: [`registry:5000/app@${OLD}`] }),
      img({ Id: 'i-new', Created: newCreated, RepoTags: ['registry:5000/app:n'], RepoDigests: [`registry:5000/app@${PROD}`] }),
    ];
    const { remove } = selectImagesToPrune(
      images,
      { keepDigests: [], repoPrefix: 'registry:5000/', strategy: 'until', untilDays: 14 },
      now,
    );
    expect(remove.map((r) => r.id)).toEqual(['i-old']);
  });

  it('dangling strategy removes only untagged images', () => {
    const images = [
      img({ Id: 'i-dangle', RepoTags: [], RepoDigests: [] }),
      img({ Id: 'i-tagged', RepoTags: ['registry:5000/app:t'], RepoDigests: [`registry:5000/app@${OLD}`] }),
    ];
    const { remove } = selectImagesToPrune(images, { keepDigests: [], strategy: 'dangling' });
    expect(remove.map((r) => r.id)).toEqual(['i-dangle']);
  });
});
