import { describe, expect, test } from 'bun:test';
import type { NodeStatsSnapshot, NodeSummary, NodeVolumeSizes } from '@swarmy/core';
import type { FleetView } from '../fleet/fleet-model';
import { roomiest } from './fit-check';
import { previewWords } from './move-words';
import { planTargets, roomFor, sizesOn } from './move-targets';

const GB = 1024 ** 3;

/** A server with a live sample: memory 4 of 16 GB, disk `freeGb` free of 100 GB. */
const server = (id: string, freeGb: number | null): FleetView =>
  ({
    server: {
      node: { id, name: id, status: 'online', resources: { memBytes: 16 * GB }, live: { cpuPercent: 1, memPercent: 25 } } as unknown as NodeSummary,
      live: {
        memUsedBytes: 4 * GB,
        memTotalBytes: 16 * GB,
        fsTotalBytes: freeGb === null ? null : 100 * GB,
        fsUsedBytes: freeGb === null ? null : (100 - freeGb) * GB,
      } as NodeStatsSnapshot,
      diskPct: null,
      containers: null,
      monthlyUsd: null,
    },
  }) as unknown as FleetView;

const servers = [server('wkr-1', 10), server('mgr-1', 31), server('mgr-2', 50), server('old', null)];
const reports: NodeVolumeSizes[] = [
  { nodeId: 'wkr-1', sampledAt: 1, volumes: [{ name: 'data_pg', sizeBytes: 4.2 * GB }] },
  { nodeId: 'mgr-1', sampledAt: 1, volumes: [] },
  { nodeId: 'mgr-2', sampledAt: null, volumes: [] },
];

const planFor = (fromId: string, sizes = reports) => {
  const targets = planTargets({ fromId, servers, needBytes: GB, volumes: ['data_pg'], sizes });
  return { block: null, checking: false, volumes: ['data_pg'], needBytes: GB, copies: 1, targets, best: roomiest(targets.filter(roomFor)) };
};

describe('move targets — the mover`s diskFit over the source`s reported sizes', () => {
  test('sizes come from the SOURCE server; one that never reported has none', () => {
    expect(sizesOn(reports, 'wkr-1')?.get('data_pg')).toBe(4.2 * GB);
    expect(sizesOn(reports, 'mgr-2')).toBeNull();
    expect(sizesOn(undefined, 'wkr-1')).toBeNull();
  });

  test('each target`s free disk against size × 1.2; a target not reporting is unknown', () => {
    const t = planFor('wkr-1').targets;
    expect(t.map((x) => [x.id, x.disk?.verdict, x.disk?.freeBytes])).toEqual([
      ['mgr-1', 'fits', 31 * GB],
      ['mgr-2', 'fits', 50 * GB],
      ['old', 'unknown', null],
    ]);
  });

  test('a target with too little disk is not suggested as the roomy one', () => {
    const tiny = [{ nodeId: 'mgr-2', sampledAt: 1, volumes: [{ name: 'data_pg', sizeBytes: 30 * GB }] }];
    const p = planFor('mgr-2', tiny);
    expect(p.targets.find((x) => x.id === 'mgr-1')?.disk?.verdict).toBe('wont-fit');
    expect(p.best?.id).toBe('old');
  });

  test('volumes still being read: no disk line yet', () => {
    const t = planTargets({ fromId: 'wkr-1', servers, needBytes: GB, volumes: undefined, sizes: reports });
    expect(t.every((x) => x.disk === null)).toBe(true);
  });
});

describe('preview words with the disk fit', () => {
  test('won`t fit on disk: refused in the mover`s own words, and the roomy server named', () => {
    const big = [{ nodeId: 'mgr-1', sampledAt: 1, volumes: [{ name: 'data_pg', sizeBytes: 9 * GB }] }];
    const p = planFor('mgr-1', big);
    const w = previewWords({ short: 'postgres', from: 'mgr-1', plan: p, target: p.targets.find((x) => x.id === 'wkr-1')! });
    expect(w).toMatchObject({ tone: 'bad', verdict: 'Won’t fit', title: 'wkr-1 doesn’t have room for postgres’s data', go: false });
    expect(w.body).toBe(
      'postgres’s data is 9.0 GB and wkr-1 has 10 GB free — swarmy wants 11 GB free so the disk doesn’t fill up. Free some space on wkr-1, or pick another server. Try mgr-2.',
    );
  });

  test('a size nobody reported: it can still go, with the caution in the body', () => {
    const p = planFor('mgr-2');
    const w = previewWords({ short: 'postgres', from: 'mgr-2', plan: p, target: p.targets.find((x) => x.id === 'mgr-1')! });
    expect(w.go).toBe(true);
    expect(w.body).toEndWith('swarmy doesn’t know how big postgres’s data is (size not reported for data_pg), so it can’t check it fits on mgr-1.');
  });

  test('fits: no disk caution', () => {
    const p = planFor('wkr-1');
    const w = previewWords({ short: 'postgres', from: 'wkr-1', plan: p, target: p.targets.find((x) => x.id === 'mgr-1')! });
    expect(w).toMatchObject({ verdict: 'Fits', go: true });
    expect(w.body).not.toContain('swarmy doesn’t know');
  });
});
