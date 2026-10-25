import { describe, expect, it } from 'bun:test';
import { MAX_REPORTED_VOLUMES } from './protocol/volume-sizes';
import { parseVolumeDf, volumePlaces, volumeSizeOn, type NodeVolumeSizes } from './volume-sizes';

/** A trimmed `GET /system/df?type=volume` answer (Docker 27). */
const DF = {
  Volumes: [
    { Name: 'shop_cache', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/shop_cache/_data', UsageData: { Size: 1_048_576, RefCount: 0 } },
    { Name: 'shop_pg', Driver: 'local', UsageData: { Size: 4_509_715_660, RefCount: 1 } },
    { Name: 'nfs_share', Driver: 'nfs', UsageData: { Size: -1, RefCount: -1 } },
    { Name: 'no_usage', Driver: 'local' },
    { Name: 'empty', Driver: 'local', UsageData: { Size: 0, RefCount: 2 } },
  ],
};

describe('parseVolumeDf — Docker`s df answer to the wire list', () => {
  it('keeps every volume Docker sized, largest first, with its ref count', () => {
    expect(parseVolumeDf(DF)).toEqual([
      { name: 'shop_pg', sizeBytes: 4_509_715_660, refCount: 1 },
      { name: 'shop_cache', sizeBytes: 1_048_576, refCount: 0 },
      { name: 'empty', sizeBytes: 0, refCount: 2 },
    ]);
  });

  it('a volume Docker could not size (-1, no UsageData) is left out, never reported as zero', () => {
    const names = parseVolumeDf(DF).map((v) => v.name);
    expect(names).not.toContain('nfs_share');
    expect(names).not.toContain('no_usage');
  });

  it('anything that is not a df answer gives an empty list; junk entries and duplicates are skipped', () => {
    expect(parseVolumeDf(null)).toEqual([]);
    expect(parseVolumeDf({})).toEqual([]);
    expect(parseVolumeDf({ Volumes: null })).toEqual([]);
    expect(parseVolumeDf('oops')).toEqual([]);
    expect(
      parseVolumeDf({ Volumes: [null, { Name: 7, UsageData: { Size: 1 } }, { Name: 'a', UsageData: { Size: '9' } }, { Name: 'b', UsageData: { Size: 3 } }, { Name: 'b', UsageData: { Size: 4 } }] }),
    ).toEqual([{ name: 'b', sizeBytes: 3 }]);
  });

  it('keeps at most MAX_REPORTED_VOLUMES, the largest', () => {
    const many = { Volumes: Array.from({ length: MAX_REPORTED_VOLUMES + 5 }, (_, i) => ({ Name: `v${i}`, UsageData: { Size: i } })) };
    const out = parseVolumeDf(many);
    expect(out).toHaveLength(MAX_REPORTED_VOLUMES);
    expect(out[0]!.sizeBytes).toBe(MAX_REPORTED_VOLUMES + 4);
    expect(out.some((v) => v.sizeBytes < 5)).toBe(false);
  });
});

describe('reading a volume`s size out of the reports', () => {
  const reports: NodeVolumeSizes[] = [
    { nodeId: 'n1', sampledAt: 1, volumes: [{ name: 'shop_pg', sizeBytes: 10 }, { name: 'shop_cache', sizeBytes: 2 }] },
    { nodeId: 'n2', sampledAt: null, volumes: [] },
    { nodeId: 'n3', sampledAt: 5, volumes: [{ name: 'shop_cache', sizeBytes: 7 }] },
  ];

  it('a size, a server that never reported, or a volume that is not there', () => {
    expect(volumeSizeOn(reports, 'n1', 'shop_pg')).toBe(10);
    expect(volumeSizeOn(reports, 'n2', 'shop_pg')).toBe('unreported');
    expect(volumeSizeOn(reports, 'nX', 'shop_pg')).toBe('unreported');
    expect(volumeSizeOn(reports, 'n3', 'shop_pg')).toBe('absent');
  });

  it('every server holding a copy of the volume', () => {
    expect(volumePlaces(reports, 'shop_cache')).toEqual([
      { nodeId: 'n1', sizeBytes: 2 },
      { nodeId: 'n3', sizeBytes: 7 },
    ]);
    expect(volumePlaces(reports, 'nope')).toEqual([]);
  });
});
