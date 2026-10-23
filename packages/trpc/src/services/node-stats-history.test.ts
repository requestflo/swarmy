import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { NODE_STATS_HISTORY_SLOTS, NODE_STATS_HISTORY_STEP_SECONDS } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { diskGridFrom } from './alerts-disk-history';
import { nodeStatsGrid, nodeStatsHistory } from './node-stats-history';

const STEP = NODE_STATS_HISTORY_STEP_SECONDS;
const NOW = Date.UTC(2026, 9, 24, 12, 2, 30);
const FROM = diskGridFrom(NOW, STEP, NODE_STATS_HISTORY_SLOTS);
const NODES = [
  { id: 'n1', name: 'london-1' },
  { id: 'n2', name: 'wkr-1' },
];

describe('nodeStatsGrid', () => {
  const slot = (i: number): number => FROM / 1000 / STEP + i;

  it('ends the grid on the slot holding now: 24 h of 5-minute slots', () => {
    expect(NODE_STATS_HISTORY_SLOTS).toBe(288);
    expect((NOW - FROM) / (STEP * 1000)).toBeGreaterThanOrEqual(287);
    expect((NOW - FROM) / (STEP * 1000)).toBeLessThan(288);
  });

  it('places peaks by slot, keeps gaps null, clamps, and drops other nodes and out-of-window rows', () => {
    const [london] = nodeStatsGrid(
      [
        { nodeId: 'n1', slot: slot(0), cpu: 12.34, mem: 40, disk: null },
        { nodeId: 'n1', slot: BigInt(slot(287)), cpu: 104, mem: 61.26, disk: 72 },
        { nodeId: 'n1', slot: slot(288), cpu: 99, mem: 99, disk: 99 },
        { nodeId: 'n1', slot: slot(-1), cpu: 99, mem: 99, disk: 99 },
        { nodeId: 'foreign', slot: slot(1), cpu: 99, mem: 99, disk: 99 },
      ],
      NODES,
      FROM,
    );
    expect(london?.name).toBe('london-1');
    expect(london?.cpu.length).toBe(288);
    expect([london?.cpu[0], london?.mem[0], london?.disk[0]]).toEqual([12.3, 40, null]);
    expect([london?.cpu[287], london?.mem[287], london?.disk[287]]).toEqual([100, 61.3, 72]);
    expect(london?.cpu[1]).toBeNull();
    expect(london?.cpu.filter((v) => v !== null).length).toBe(2);
  });

  it('leaves out a server with no reading', () => {
    expect(nodeStatsGrid([], NODES, FROM)).toEqual([]);
  });
});

describe('nodeStatsHistory over telemetry.db', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    for (const org of ['org', 'other']) await t.db.organization.create({ data: { id: org, name: org, slug: org } });
    for (const n of NODES) await t.db.node.create({ data: { ...n, orgId: 'org', hostname: n.name } });
    await t.db.node.create({ data: { id: 'x1', name: 'theirs', orgId: 'other', hostname: 'theirs' } });
  });
  afterEach(async () => {
    await t.close();
  });

  const ctx = (orgId = 'org'): OrgContext => ({ activeOrgId: orgId, db: t.db, telemetry: t.telemetry }) as unknown as OrgContext;

  const sample = (orgId: string, nodeId: string, minutesAgo: number, v: { cpu: number; mem: number; disk: number }) =>
    t.telemetry.metricSample.create({
      data: {
        orgId,
        nodeId,
        scope: 'NODE',
        cpuPercent: v.cpu,
        memUsedBytes: BigInt(v.mem * 1_000_000),
        memTotalBytes: 100_000_000n,
        netRxBytes: 0n,
        netTxBytes: 0n,
        diskUsedBytes: BigInt(v.disk * 1_000_000),
        diskTotalBytes: v.disk ? 100_000_000n : 0n,
        ts: new Date(NOW - minutesAgo * 60_000),
      },
    });

  it('folds per-minute samples into 5-minute peaks, behind the org wall', async () => {
    // The 12:00 slot: two samples → each metric's peak. Another org's 99% on the same node id never shows.
    await sample('org', 'n1', 2, { cpu: 20, mem: 50, disk: 70 });
    await sample('org', 'n1', 1, { cpu: 35, mem: 48, disk: 71 });
    await sample('other', 'n1', 1, { cpu: 99, mem: 99, disk: 99 });
    // An hour ago, with no disk reading (total 0): disk stays a gap, not a zero.
    await sample('org', 'n2', 60, { cpu: 5, mem: 30, disk: 0 });
    // Older than 24 h: outside the window.
    await sample('org', 'n2', 25 * 60, { cpu: 99, mem: 99, disk: 99 });
    const h = await nodeStatsHistory(ctx(), {}, NOW);
    expect(h).toMatchObject({ from: new Date(FROM).toISOString(), stepSeconds: STEP, fold: 'peak' });
    const london = h.servers.find((s) => s.name === 'london-1')!;
    expect([london.cpu.at(-1), london.mem.at(-1), london.disk.at(-1)]).toEqual([35, 50, 71]);
    expect(london.cpu.filter((v) => v !== null)).toEqual([35]);
    const wkr = h.servers.find((s) => s.name === 'wkr-1')!;
    expect(wkr.cpu.filter((v) => v !== null)).toEqual([5]);
    expect(wkr.disk.every((v) => v === null)).toBe(true);
    expect(h.servers.map((s) => s.nodeId)).toEqual(['n1', 'n2']);
  });

  it('narrows to one server; another org`s server or an unknown id reads empty', async () => {
    await sample('org', 'n1', 1, { cpu: 10, mem: 10, disk: 10 });
    await sample('org', 'n2', 1, { cpu: 20, mem: 20, disk: 20 });
    await sample('other', 'x1', 1, { cpu: 30, mem: 30, disk: 30 });
    expect((await nodeStatsHistory(ctx(), { nodeId: 'n2' }, NOW)).servers.map((s) => s.name)).toEqual(['wkr-1']);
    expect((await nodeStatsHistory(ctx(), { nodeId: 'x1' }, NOW)).servers).toEqual([]);
    expect((await nodeStatsHistory(ctx(), { nodeId: 'nope' }, NOW)).servers).toEqual([]);
    // The other org sees only its own server.
    expect((await nodeStatsHistory(ctx('other'), {}, NOW)).servers.map((s) => s.name)).toEqual(['theirs']);
  });
});
