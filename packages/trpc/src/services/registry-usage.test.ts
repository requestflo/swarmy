import { describe, expect, it } from 'bun:test';
import { getRegistryUsage, recordRegistryUsage } from './registry-usage';

describe('registry usage memo', () => {
  it('is null until measured, keeps the last cleanup across plain measurements', () => {
    expect(getRegistryUsage('memo-org')).toBeNull();
    const t1 = new Date('2026-10-24T06:00:00Z');
    const t2 = new Date('2026-10-24T12:00:00Z');
    recordRegistryUsage('memo-org', { sizeBytes: 900, repos: 2, images: 7 }, t1, { deleted: 3, reclaimedBytes: 100 });
    recordRegistryUsage('memo-org', { sizeBytes: 950, repos: 2, images: 8 }, t2);
    expect(getRegistryUsage('memo-org')).toEqual({
      sizeBytes: 950,
      repos: 2,
      images: 8,
      measuredAt: t2.toISOString(),
      lastGc: { at: t1.toISOString(), deleted: 3, reclaimedBytes: 100 },
    });
  });
});
