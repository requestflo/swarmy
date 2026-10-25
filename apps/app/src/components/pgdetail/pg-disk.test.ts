import { describe, expect, test } from 'bun:test';
import type { NodeStatsSnapshot, NodeSummary, NodeVolumeSizes } from '@swarmy/core';
import { diskCopies, diskLine } from './pg-disk';
import type { PgTopoMember } from './pg-topology';

const GB = 1024 ** 3;
const node = (id: string): NodeSummary => ({ id, name: id, status: 'online' }) as NodeSummary;
const members: PgTopoMember[] = [
  { service: 'shop_db-primary', role: 'primary', status: 'running', desired: 1, running: 1, dataVolume: 'shop_db-primary-data' },
  { service: 'shop_db-replica', role: 'replica', status: 'running', desired: 2, running: 2, dataVolume: 'shop_db-replica-data' },
];
const place = new Map([
  ['shop_db-primary', [node('wkr-1')]],
  ['shop_db-replica', [node('mgr-2'), node('wkr-2')]],
]);
const reports: NodeVolumeSizes[] = [
  { nodeId: 'wkr-1', sampledAt: 1, volumes: [{ name: 'shop_db-primary-data', sizeBytes: 4.1 * GB }] },
  { nodeId: 'mgr-2', sampledAt: 1, volumes: [{ name: 'shop_db-replica-data', sizeBytes: 4 * GB }] },
  { nodeId: 'wkr-2', sampledAt: null, volumes: [] },
];
const live = (usedGb: number, totalGb: number) => ({ fsUsedBytes: usedGb * GB, fsTotalBytes: totalGb * GB }) as NodeStatsSnapshot;
const stats = new Map<string, NodeStatsSnapshot | null>([['wkr-1', live(69, 100)], ['mgr-2', live(92, 100)], ['wkr-2', null]]);

describe('diskCopies', () => {
  test('one entry per copy per server, the main copy first; unreported stays null', () => {
    const copies = diskCopies(members, place, reports, stats);
    expect(copies.map((c) => [c.server, c.main, c.dataBytes, c.freeBytes])).toEqual([
      ['wkr-1', true, 4.1 * GB, 31 * GB],
      ['mgr-2', false, 4 * GB, 8 * GB],
      ['wkr-2', false, null, null],
    ]);
  });
});

describe('diskLine', () => {
  test('the main copy’s data and its room; a full standby server is worth a word', () => {
    const l = diskLine(diskCopies(members, place, reports, stats))!;
    expect([l.label, l.tone]).toEqual(['4.1 GB', 'warn']);
    expect(l.hint).toBe('mgr-2 is 92% full. Free some space before the data grows into it.');
    expect(l.tech).toEqual([
      'wkr-1 · shop_db-primary-data · 4.1 GB · 31 GB free (69% used)',
      'mgr-2 · shop_db-replica-data · 4.0 GB · 8.0 GB free (92% used)',
      'wkr-2 · shop_db-replica-data · size not reported · free not reported',
    ]);
  });

  test('calm when there is room', () => {
    const roomy = new Map(stats).set('mgr-2', live(40, 100));
    expect(diskLine(diskCopies(members, place, reports, roomy))!.hint).toBe('The main copy’s data, on wkr-1, which has 31 GB free. Each standby copy keeps its own.');
  });

  test('a main copy whose agent predates the report is never a zero', () => {
    const l = diskLine(diskCopies(members.slice(0, 1), new Map([['shop_db-primary', [node('wkr-2')]]]), reports, stats))!;
    expect(l.label).toBe('Size not reported');
    expect(l.hint).toBe('wkr-2’s agent hasn’t reported volume sizes yet; its free disk isn’t reported.');
  });

  test('legacy storage (no data volume) has no line', () => {
    expect(diskLine(diskCopies([{ ...members[0]!, dataVolume: undefined }], place, reports, stats))).toBeNull();
  });
});
