import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { DISK_HISTORY_STEP_SECONDS, diskGridFrom, diskHistory, diskPeaksGrid } from './alerts-disk-history';

const STEP_MS = DISK_HISTORY_STEP_SECONDS * 1000;
const NOW = Date.UTC(2026, 9, 23, 12, 2, 30);
const NODES = [
  { id: 'n1', name: 'london-2' },
  { id: 'n2', name: 'wkr-1' },
];

describe('diskPeaksGrid', () => {
  const from = diskGridFrom(NOW);
  const slot = (i: number): number => from / 1000 / DISK_HISTORY_STEP_SECONDS + i;

  it('ends the grid on the slot holding now, 7 days of 5-minute slots', () => {
    expect((NOW - from) / STEP_MS).toBeLessThan(2016);
    expect((NOW - from) / STEP_MS).toBeGreaterThanOrEqual(2015);
  });

  it('places peaks by slot, keeps gaps null and drops other nodes and out-of-window rows', () => {
    const rows = [
      { nodeId: 'n1', slot: slot(0), peak: 81.04 },
      { nodeId: 'n1', slot: BigInt(slot(2015)), peak: 86.26 },
      { nodeId: 'n1', slot: slot(2016), peak: 99 },
      { nodeId: 'n1', slot: slot(-1), peak: 99 },
      { nodeId: 'foreign', slot: slot(1), peak: 99 },
    ];
    const [london] = diskPeaksGrid(rows, NODES, from);
    expect(london?.name).toBe('london-2');
    expect(london?.peaks.length).toBe(2016);
    expect(london?.peaks[0]).toBe(81);
    expect(london?.peaks[1]).toBeNull();
    expect(london?.peaks[2015]).toBe(86.3);
    expect(london?.peaks.filter((v) => v !== null).length).toBe(2);
  });

  it('leaves out a server with no samples', () => {
    expect(diskPeaksGrid([], NODES, from)).toEqual([]);
  });
});

describe('diskHistory over telemetry.db', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const ctx = (): OrgContext =>
    ({
      activeOrgId: 'org',
      telemetry: t.telemetry,
      db: {
        node: {
          findMany: async ({ where }: { where: { orgId: string; name?: string } }) =>
            where.orgId === 'org' ? NODES.filter((n) => !where.name || n.name === where.name) : [],
        },
      },
    }) as unknown as OrgContext;

  const sample = (orgId: string, nodeId: string, minutesAgo: number, pct: number) =>
    t.telemetry.metricSample.create({
      data: {
        orgId,
        nodeId,
        scope: 'NODE',
        cpuPercent: 1,
        memUsedBytes: 1n,
        memTotalBytes: 2n,
        netRxBytes: 0n,
        netTxBytes: 0n,
        diskUsedBytes: BigInt(pct * 1_000_000),
        diskTotalBytes: 100_000_000n,
        ts: new Date(NOW - minutesAgo * 60_000),
      },
    });

  it('folds per-minute samples into 5-minute peaks, org-scoped', async () => {
    // 12:00–12:02 slot: 80% then 82% → peak 82. Another org's 99% on the same node id never shows.
    await sample('org', 'n1', 2, 80);
    await sample('org', 'n1', 1, 82);
    await sample('other', 'n1', 1, 99);
    await sample('org', 'n2', 60, 57);
    // Older than 7 days: outside the window.
    await sample('org', 'n2', 8 * 24 * 60, 99);
    const h = await diskHistory(ctx(), {}, NOW);
    expect(h.stepSeconds).toBe(DISK_HISTORY_STEP_SECONDS);
    expect(Date.parse(h.from)).toBe(diskGridFrom(NOW));
    const london = h.servers.find((s) => s.name === 'london-2')!;
    expect(london.peaks.at(-1)).toBe(82);
    expect(london.peaks.filter((v) => v !== null)).toEqual([82]);
    const wkr = h.servers.find((s) => s.name === 'wkr-1')!;
    expect(wkr.peaks.filter((v) => v !== null)).toEqual([57]);
  });

  it('narrows to one server, and an unknown one reads empty', async () => {
    await sample('org', 'n1', 1, 82);
    await sample('org', 'n2', 1, 57);
    expect((await diskHistory(ctx(), { server: 'wkr-1' }, NOW)).servers.map((s) => s.name)).toEqual(['wkr-1']);
    expect((await diskHistory(ctx(), { server: 'nope' }, NOW)).servers).toEqual([]);
  });
});
