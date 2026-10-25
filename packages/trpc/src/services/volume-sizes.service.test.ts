import { describe, expect, it } from 'bun:test';
import { listVolumeSizes } from './volume-sizes.service';

describe('nodes.volumeSizes — served from hub memory, one row per server', () => {
  const ctx = (hub: object) =>
    ({
      activeOrgId: 'org',
      db: { node: { findMany: async () => [{ id: 'n1' }, { id: 'n2' }] } },
      hub,
    }) as never;

  it('a reporting server gives its sizes; one that never reported (older agent) gives sampledAt null', async () => {
    const reports: Record<string, object> = { n1: { sampledAt: 9, volumes: [{ name: 'shop_pg', sizeBytes: 42, refCount: 1 }] } };
    const rows = await listVolumeSizes(ctx({ volumeSizesFor: (id: string) => reports[id] }));
    expect(rows).toEqual([
      { nodeId: 'n1', sampledAt: 9, volumes: [{ name: 'shop_pg', sizeBytes: 42 }] },
      { nodeId: 'n2', sampledAt: null, volumes: [] },
    ]);
  });

  it('a hub without the report (tests, demo) reads as not reported, never as zero', async () => {
    const rows = await listVolumeSizes(ctx({}));
    expect(rows.every((r) => r.sampledAt === null && r.volumes.length === 0)).toBe(true);
  });
});
