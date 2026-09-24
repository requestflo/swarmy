import { describe, expect, it } from 'bun:test';
import {
  formatBytes,
  hygieneKeepSet,
  hygieneSettingsFromLabels,
  hygieneSummary,
} from './node-hygiene.service';

const PROD = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const PREV = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
const OLD = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';

describe('hygiene keep set — never an in-prod digest, never the previous release', () => {
  it('keeps pinned digests, every live service image (digest + tag), and the last 2 builds per repo', () => {
    const keep = hygieneKeepSet({
      pinnedDigests: [PROD],
      serviceImages: ['localhost:5000/app:main@' + PROD, 'nginx:1.27', 'redis'],
      recentBuilds: [
        { repoId: 'r1', image: `localhost:5000/app@${PROD}` },
        { repoId: 'r1', image: `localhost:5000/app@${PREV}` },
        { repoId: 'r1', image: `localhost:5000/app@${OLD}` },
        { repoId: 'r2', image: null },
      ],
    });
    expect(keep.keepDigests).toEqual([PROD, PREV]);
    expect(keep.keepDigests).not.toContain(OLD);
    expect(keep.keepRefs).toEqual(['localhost:5000/app:main', 'nginx:1.27', 'redis']);
  });
});

describe('hygiene settings from node labels', () => {
  it('defaults on, 7 days, 5 GB; labels override; junk falls back', () => {
    expect(hygieneSettingsFromLabels(undefined)).toEqual({
      enabled: true,
      imageMinAgeDays: 7,
      buildCacheKeepBytes: 5 * 1024 ** 3,
    });
    expect(
      hygieneSettingsFromLabels({
        'swarmy.hygiene.enabled': 'false',
        'swarmy.hygiene.imageAgeDays': '30',
        'swarmy.hygiene.buildCacheGb': '0.5',
      }),
    ).toEqual({ enabled: false, imageMinAgeDays: 30, buildCacheKeepBytes: 536870912 });
    expect(hygieneSettingsFromLabels({ 'swarmy.hygiene.imageAgeDays': 'soon', 'swarmy.hygiene.buildCacheGb': '-1' })).toEqual(
      hygieneSettingsFromLabels(undefined),
    );
  });
});

describe('activity summary', () => {
  it('reads "reclaimed X GB" in plain words', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2.34 * 1024 ** 3)).toBe('2.3 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(
      hygieneSummary({
        containers: { removed: 3, reclaimedBytes: 1024 ** 2 },
        images: { removed: 14, kept: 20, reclaimedBytes: 1.2 * 1024 ** 3 },
        buildCache: { reclaimedBytes: 1.1 * 1024 ** 3 },
        reclaimedBytes: 2.3 * 1024 ** 3 + 1024 ** 2,
        dryRun: false,
        errors: [],
      }),
    ).toBe('Cleanup reclaimed 2.3 GB (14 images, 3 stopped containers, build cache 1.1 GB)');
  });
});
