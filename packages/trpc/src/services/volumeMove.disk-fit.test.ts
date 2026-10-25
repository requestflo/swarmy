import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo, VolumeSizesSample } from '@swarmy/core/protocol';
import { planServiceMove } from './volumeMove.service';

const GiB = 1024 ** 3;

/**
 * planServiceMove's disk fit (board 9): blog_ghost's two volumes run on fra-1
 * (n1) and are asked onto hel-1 (n2). Sizes come from n1's report, free disk
 * from n2's live stats.
 */
function ctxWith(o: { sizes?: VolumeSizesSample; freeGiB?: number | null }) {
  const svc = {
    id: 's1',
    name: 'blog_ghost',
    mode: 'replicated',
    desiredReplicas: 1,
    labels: {},
    mounts: [
      { type: 'volume', source: 'blog_content', target: '/content' },
      { type: 'volume', source: 'blog_db', target: '/db' },
    ],
  } as unknown as SwarmServiceInfo;
  const hub = {
    onlineNodeIds: () => ['n1', 'n2'],
    isOnline: () => true,
    latestContainers: (n: string) => (n === 'n1' ? [{ state: 'running', labels: { 'com.docker.swarm.service.name': 'blog_ghost' } }] : []),
    liveInventory: () => ({ services: [svc], containers: [] }),
    nodeInfoFor: (n: string) => ({ hostname: n === 'n1' ? 'fra-1' : 'hel-1', availability: 'active', status: 'ready' }),
    swarmNodeIdFor: (n: string) => `sw-${n}`,
    managerNode: () => 'n1',
    volumeSizesFor: (n: string) => (n === 'n1' ? o.sizes : undefined),
    latestNodeStats: (n: string) =>
      n === 'n2' && o.freeGiB !== null && o.freeGiB !== undefined ? { fsTotalBytes: 100 * GiB, fsUsedBytes: (100 - o.freeGiB) * GiB } : undefined,
  };
  return { hub, activeOrgId: 'org' } as never;
}

const sized = (content: number, db: number): VolumeSizesSample => ({
  sampledAt: 1,
  volumes: [
    { name: 'blog_content', sizeBytes: content * GiB },
    { name: 'blog_db', sizeBytes: db * GiB },
    { name: 'other_app', sizeBytes: 500 * GiB },
  ],
});

describe('planServiceMove — refuses when the data won`t fit on the target`s disk', () => {
  it('fits: both volumes × 1.2 under the free disk, no warning', async () => {
    const plan = await planServiceMove(ctxWith({ sizes: sized(3, 1.2), freeGiB: 31 }), { service: 'blog_ghost', toNodeId: 'n2' });
    expect(plan.disk).toMatchObject({ verdict: 'fits', needBytes: 4.2 * GiB, freeBytes: 31 * GiB });
    expect(plan.warnings).toEqual([]);
  });

  it('won`t fit: refused up front with a plain reason, before anything moves', async () => {
    const run = planServiceMove(ctxWith({ sizes: sized(8, 2), freeGiB: 11 }), { service: 'blog_ghost', toNodeId: 'n2' });
    await expect(run).rejects.toThrow(
      'blog_ghost’s data is 10 GB and hel-1 has 11 GB free — swarmy wants 12 GB free so the disk doesn’t fill up. Free some space on hel-1, or pick another server.',
    );
  });

  it('an older agent that reports no sizes: the move goes ahead, with a warning', async () => {
    const plan = await planServiceMove(ctxWith({ freeGiB: 31 }), { service: 'blog_ghost', toNodeId: 'n2' });
    expect(plan.disk.verdict).toBe('unknown');
    expect(plan.warnings).toEqual([
      'swarmy doesn’t know how big blog_ghost’s data is (size not reported for blog_content, blog_db), so it can’t check it fits on hel-1.',
    ]);
  });

  it('a target not reporting its free disk warns too; a hub with neither (tests, older controllers) never refuses', async () => {
    const plan = await planServiceMove(ctxWith({ sizes: sized(1, 1), freeGiB: null }), { service: 'blog_ghost', toNodeId: 'n2' });
    expect(plan.warnings).toEqual(['hel-1 isn’t reporting its free disk, so swarmy can’t check blog_ghost’s data fits.']);
    const ctx = ctxWith({}) as { hub: Record<string, unknown> };
    delete ctx.hub.volumeSizesFor;
    delete ctx.hub.latestNodeStats;
    expect((await planServiceMove(ctx as never, { service: 'blog_ghost', toNodeId: 'n2' })).disk.verdict).toBe('unknown');
  });
});
