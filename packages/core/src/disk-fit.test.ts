import { describe, expect, it } from 'bun:test';
import { DISK_FIT_HEADROOM, diskFit, diskFitLine, diskFitRefusal, diskFitWarning, diskSizeWord, freeDiskBytes } from './disk-fit';

const GiB = 1024 ** 3;
const sizes = (o: Record<string, number>) => new Map(Object.entries(o));

describe('diskFit — the data must fit on the target with 20% to spare', () => {
  it('fits when free ≥ size × 1.2', () => {
    const f = diskFit({ volumes: ['pg', 'wal'], sizes: sizes({ pg: 3 * GiB, wal: 1 * GiB }), freeBytes: 31 * GiB });
    expect(f).toEqual({ verdict: 'fits', needBytes: 4 * GiB, knownBytes: 4 * GiB, requiredBytes: Math.ceil(4 * GiB * 1.2), freeBytes: 31 * GiB, unreported: [] });
    expect(DISK_FIT_HEADROOM).toBe(1.2);
  });

  it('won`t fit when the free disk is under size × 1.2, even though the data alone would squeeze in', () => {
    expect(diskFit({ volumes: ['pg'], sizes: sizes({ pg: 10 * GiB }), freeBytes: 11 * GiB }).verdict).toBe('wont-fit');
    expect(diskFit({ volumes: ['pg'], sizes: sizes({ pg: 10 * GiB }), freeBytes: 12 * GiB }).verdict).toBe('fits');
  });

  it('an unreported size is unknown — a warning, never a zero that fits', () => {
    const none = diskFit({ volumes: ['pg'], sizes: null, freeBytes: 31 * GiB });
    expect(none.verdict).toBe('unknown');
    expect(none.needBytes).toBeNull();
    expect(none.unreported).toEqual(['pg']);
    const partly = diskFit({ volumes: ['pg', 'wal'], sizes: sizes({ pg: 1 * GiB }), freeBytes: 31 * GiB });
    expect(partly).toMatchObject({ verdict: 'unknown', needBytes: null, knownBytes: 1 * GiB, unreported: ['wal'] });
  });

  it('what IS known already not fitting is a refusal, even with sizes missing', () => {
    const f = diskFit({ volumes: ['pg', 'wal'], sizes: sizes({ pg: 40 * GiB }), freeBytes: 30 * GiB });
    expect(f.verdict).toBe('wont-fit');
    expect(f.needBytes).toBeNull();
  });

  it('a target not reporting its free disk is unknown; empty volumes fit anywhere that reports', () => {
    expect(diskFit({ volumes: ['pg'], sizes: sizes({ pg: GiB }), freeBytes: null }).verdict).toBe('unknown');
    expect(diskFit({ volumes: ['pg'], sizes: sizes({ pg: 0 }), freeBytes: 0 }).verdict).toBe('fits');
    expect(diskFit({ volumes: ['pg', 'pg'], sizes: sizes({ pg: GiB }), freeBytes: 2 * GiB }).needBytes).toBe(GiB);
  });

  it('free disk from a stats sample; missing or zero totals are unknown', () => {
    expect(freeDiskBytes({ fsTotalBytes: 100, fsUsedBytes: 60 })).toBe(40);
    expect(freeDiskBytes({ fsTotalBytes: 100, fsUsedBytes: null })).toBeNull();
    expect(freeDiskBytes({ fsTotalBytes: 0, fsUsedBytes: 0 })).toBeNull();
    expect(freeDiskBytes(undefined)).toBeNull();
  });
});

describe('disk fit in words', () => {
  it('the Move dialog line', () => {
    expect(diskFitLine(diskFit({ volumes: ['pg'], sizes: sizes({ pg: 4.2 * GiB }), freeBytes: 31 * GiB }))).toBe('needs 4.2 GB · target has 31 GB free');
    expect(diskFitLine(diskFit({ volumes: ['pg'], sizes: null, freeBytes: 31 * GiB }))).toBe('size not reported · target has 31 GB free');
    expect(diskFitLine(diskFit({ volumes: ['pg', 'wal'], sizes: sizes({ pg: 2 * GiB }), freeBytes: null }))).toBe(
      'needs at least 2.0 GB (size not reported for wal) · target’s free disk not reported',
    );
  });

  it('sizes: MB under a gigabyte, one decimal under ten, whole above', () => {
    expect(diskSizeWord(640 * 1024 ** 2)).toBe('640 MB');
    expect(diskSizeWord(10)).toBe('1 MB');
    expect(diskSizeWord(0)).toBe('0 MB');
    expect(diskSizeWord(4.24 * GiB)).toBe('4.2 GB');
    expect(diskSizeWord(31.4 * GiB)).toBe('31 GB');
  });

  it('the refusal and the warning are plain sentences', () => {
    const tight = diskFit({ volumes: ['pg'], sizes: sizes({ pg: 10 * GiB }), freeBytes: 11 * GiB });
    expect(diskFitRefusal('blog_ghost', 'hel-1', tight)).toBe(
      'blog_ghost’s data is 10 GB and hel-1 has 11 GB free — swarmy wants 12 GB free so the disk doesn’t fill up. Free some space on hel-1, or pick another server.',
    );
    expect(diskFitWarning('blog_ghost', 'hel-1', tight)).toBeNull();
    expect(diskFitWarning('blog_ghost', 'hel-1', diskFit({ volumes: ['pg'], sizes: null, freeBytes: 1 }))).toBe(
      'swarmy doesn’t know how big blog_ghost’s data is (size not reported for pg), so it can’t check it fits on hel-1.',
    );
    expect(diskFitWarning('blog_ghost', 'hel-1', diskFit({ volumes: ['pg'], sizes: sizes({ pg: 1 }), freeBytes: null }))).toBe(
      'hel-1 isn’t reporting its free disk, so swarmy can’t check blog_ghost’s data fits.',
    );
  });
});
