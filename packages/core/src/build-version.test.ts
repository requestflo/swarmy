import { describe, expect, it } from 'bun:test';
import { buildVersion, versionFromTag } from './build-version';

describe('versionFromTag', () => {
  it('reads version tags and puts a v in front', () => {
    expect(versionFromTag('1.4.0')).toBe('v1.4.0');
    expect(versionFromTag('v2.0.0-rc.1')).toBe('v2.0.0-rc.1');
    expect(versionFromTag('refs/tags/v1.9')).toBe('v1.9');
    expect(versionFromTag('v119')).toBe('v119');
  });

  it('never reads a sha, a branch, a bare number or nothing as a version', () => {
    expect(versionFromTag('4e1c09a')).toBeNull();
    expect(versionFromTag('4e1c09a7b2d3')).toBeNull();
    expect(versionFromTag('main')).toBeNull();
    expect(versionFromTag('feature-1.2')).toBeNull();
    expect(versionFromTag('42')).toBeNull();
    expect(versionFromTag('latest')).toBeNull();
    expect(versionFromTag(null)).toBeNull();
  });
});

describe('buildVersion', () => {
  const sha = '4e1c09a7b2d3e5f60718293a4b5c6d7e8f901234';

  it('takes the git tag the build was asked for first', () => {
    expect(buildVersion({ commit: 'v1.4.0', image: 'localhost:5000/shop:v1.4.0' })).toBe('v1.4.0');
  });

  it('falls back to the image tag, then a version-tagged image in the release', () => {
    expect(buildVersion({ commit: sha, image: 'localhost:5000/shop:1.4.0@sha256:abc' })).toBe('v1.4.0');
    expect(
      buildVersion({
        commit: sha,
        image: 'localhost:5000/shop:4e1c09a7b2d3',
        releaseImages: [{ image: 'localhost:5000/shop@sha256:abc' }, { image: 'ghcr.io/acme/web:2.3.1@sha256:def' }],
      }),
    ).toBe('v2.3.1');
  });

  it('is null for a commit build deployed by digest (the page keeps the short commit)', () => {
    expect(buildVersion({ commit: sha, image: `localhost:5000/shop:${sha.slice(0, 12)}`, releaseImages: [{ image: 'localhost:5000/shop@sha256:abc' }] })).toBeNull();
    expect(buildVersion({ commit: 'main', image: 'localhost:5000/shop:main' })).toBeNull();
    expect(buildVersion({ commit: null, image: null })).toBeNull();
  });
});
