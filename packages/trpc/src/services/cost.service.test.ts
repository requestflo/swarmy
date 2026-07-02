import { describe, expect, it } from 'bun:test';
import type { CostIdleServiceView, CostNodeView, CostOversizedNodeView } from '@swarmy/core';
import {
  buildRecommendations,
  encodeNodeCost,
  estimateStackCosts,
  parseNodeCost,
  type CostContainerInput,
  type CostNodeInput,
  type ServiceMeta,
} from './cost.service';

const GB = 1024 ** 3;

function metaMap(entries: Array<[string, ServiceMeta]>): Map<string, ServiceMeta> {
  return new Map(entries);
}

describe('parseNodeCost / encodeNodeCost — the swarmy.node.cost label codec', () => {
  it('parses a plain decimal', () => {
    expect(parseNodeCost({ 'swarmy.node.cost': '42.5' })).toBe(42.5);
  });

  it('treats missing / empty / garbage / negative as unpriced', () => {
    expect(parseNodeCost(undefined)).toBeNull();
    expect(parseNodeCost({})).toBeNull();
    expect(parseNodeCost({ 'swarmy.node.cost': '' })).toBeNull();
    expect(parseNodeCost({ 'swarmy.node.cost': '  ' })).toBeNull();
    expect(parseNodeCost({ 'swarmy.node.cost': 'cheap' })).toBeNull();
    expect(parseNodeCost({ 'swarmy.node.cost': '-5' })).toBeNull();
  });

  it('encodes null as the empty string (merge-only label delete)', () => {
    expect(encodeNodeCost(null)).toBe('');
    expect(encodeNodeCost(40)).toBe('40');
    expect(encodeNodeCost(19.999)).toBe('20');
    // round-trips
    expect(parseNodeCost({ 'swarmy.node.cost': encodeNodeCost(12.345) })).toBe(12.35);
  });
});

describe('estimateStackCosts — memory-share attribution', () => {
  const node = (id: string, usd: number | null, memGb = 8): CostNodeInput => ({
    nodeId: id,
    monthlyUsd: usd,
    memTotalBytes: memGb * GB,
  });
  const ctr = (
    nodeId: string,
    serviceId: string,
    limitGb: number,
    usedGb: number,
  ): CostContainerInput => ({
    nodeId,
    serviceId,
    memLimitBytes: limitGb * GB,
    memUsedBytes: usedGb * GB,
  });

  it('uses the memory LIMIT share when a real limit is configured', () => {
    // 2 GB limit on an 8 GB / $80 node → 25% → $20.
    const est = estimateStackCosts(
      [node('n1', 80)],
      [ctr('n1', 'svc-a', 2, 0.5)],
      metaMap([['svc-a', { name: 'api', stack: 'store' }]]),
    );
    expect(est.stacks).toEqual([{ stack: 'store', serviceCount: 1, monthlyUsd: 20, partial: false }]);
    expect(est.serviceMonthlyUsd['svc-a']).toBe(20);
    expect(est.allocatedUsd).toBe(20);
  });

  it('falls back to USAGE share when the "limit" is the host total (unlimited)', () => {
    // Docker reports limit = node mem when unconfigured → use 1 GB usage → 12.5% → $10.
    const est = estimateStackCosts(
      [node('n1', 80)],
      [ctr('n1', 'svc-a', 8, 1)],
      metaMap([['svc-a', { name: 'api', stack: 'store' }]]),
    );
    expect(est.stacks[0]?.monthlyUsd).toBe(10);
  });

  it('sums containers across nodes and services into their stack', () => {
    const est = estimateStackCosts(
      [node('n1', 80), node('n2', 40, 4)],
      [
        ctr('n1', 'svc-a', 2, 1), // $20
        ctr('n1', 'svc-b', 4, 2), // $40
        ctr('n2', 'svc-b', 1, 0.5), // 25% of $40 = $10
      ],
      metaMap([
        ['svc-a', { name: 'api', stack: 'store' }],
        ['svc-b', { name: 'worker', stack: 'store' }],
      ]),
    );
    expect(est.stacks).toEqual([{ stack: 'store', serviceCount: 2, monthlyUsd: 70, partial: false }]);
    expect(est.serviceMonthlyUsd).toEqual({ 'svc-a': 20, 'svc-b': 50 });
  });

  it('does NOT normalise shares — unallocated capacity stays unattributed', () => {
    // One tiny container on a big node: allocated ≪ node cost.
    const est = estimateStackCosts(
      [node('n1', 100, 16)],
      [ctr('n1', 'svc-a', 1, 0.2)],
      metaMap([['svc-a', { name: 'api', stack: 'store' }]]),
    );
    expect(est.allocatedUsd).toBe(6.25); // 1/16 of $100
  });

  it('marks stacks partial when containers sit on unpriced nodes', () => {
    const est = estimateStackCosts(
      [node('n1', 80), node('n2', null)],
      [ctr('n1', 'svc-a', 2, 1), ctr('n2', 'svc-b', 2, 1)],
      metaMap([
        ['svc-a', { name: 'api', stack: 'store' }],
        ['svc-b', { name: 'worker', stack: 'store' }],
      ]),
    );
    expect(est.stacks[0]).toMatchObject({ monthlyUsd: 20, partial: true, serviceCount: 2 });
  });

  it('caps weight at 100% of the node and guards zero-memory nodes', () => {
    const est = estimateStackCosts(
      [node('n1', 50, 2), node('n0', 99, 0)],
      [
        // used > node mem (bogus sample) → capped at node mem → full $50
        { nodeId: 'n1', serviceId: 'svc-a', memLimitBytes: 0, memUsedBytes: 4 * GB },
        { nodeId: 'n0', serviceId: 'svc-b', memLimitBytes: GB, memUsedBytes: GB },
      ],
      metaMap([
        ['svc-a', { name: 'api', stack: 'a' }],
        ['svc-b', { name: 'other', stack: 'b' }],
      ]),
    );
    expect(est.serviceMonthlyUsd['svc-a']).toBe(50);
    expect(est.serviceMonthlyUsd['svc-b']).toBeUndefined();
  });

  it('ignores containers whose service is not in the inventory', () => {
    const est = estimateStackCosts(
      [node('n1', 80)],
      [ctr('n1', 'svc-gone', 2, 1)],
      metaMap([]),
    );
    expect(est.stacks).toEqual([]);
    expect(est.allocatedUsd).toBe(0);
  });

  it('sorts stacks by cost desc, then name', () => {
    const est = estimateStackCosts(
      [node('n1', 100, 10)],
      [
        ctr('n1', 'svc-a', 1, 1), // $10 → stack b
        ctr('n1', 'svc-b', 3, 1), // $30 → stack a
      ],
      metaMap([
        ['svc-a', { name: 'x', stack: 'b' }],
        ['svc-b', { name: 'y', stack: 'a' }],
      ]),
    );
    expect(est.stacks.map((s) => s.stack)).toEqual(['a', 'b']);
  });
});

describe('buildRecommendations — the rule list', () => {
  const nodeView = (over: Partial<CostNodeView> & Pick<CostNodeView, 'nodeId' | 'name'>): CostNodeView => ({
    online: true,
    monthlyUsd: null,
    cpuCores: 4,
    memGb: 8,
    cpuUtilPct: 50,
    memUtilPct: 50,
    utilSource: 'live',
    ...over,
  });

  it('nudges unpriced nodes (no savings guess)', () => {
    const recs = buildRecommendations({
      nodes: [nodeView({ nodeId: 'n1', name: 'wkr-1' })],
      oversizedNodes: [],
      idleServices: [],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: 'unpriced-node:n1',
      kind: 'unpriced-node',
      savingsUsd: null,
    });
    expect(recs[0]!.message).toContain('wkr-1');
  });

  it('flags offline-but-priced nodes with the full cost as the saving', () => {
    const recs = buildRecommendations({
      nodes: [nodeView({ nodeId: 'n1', name: 'wkr-1', online: false, monthlyUsd: 40 })],
      oversizedNodes: [],
      idleServices: [],
    });
    expect(recs[0]).toMatchObject({ kind: 'offline-node', savingsUsd: 40 });
    expect(recs[0]!.message).toContain('$40/mo');
  });

  it('guesses half the node cost for oversized nodes', () => {
    const oversized: CostOversizedNodeView = {
      nodeId: 'n3',
      name: 'worker-3',
      avgCpuPct: 2,
      avgMemPct: 11,
      monthlyUsd: 36,
      windowDays: 7,
    };
    const recs = buildRecommendations({ nodes: [], oversizedNodes: [oversized], idleServices: [] });
    expect(recs[0]).toMatchObject({ id: 'oversized-node:n3', savingsUsd: 18 });
    expect(recs[0]!.message).toContain('worker-3');
    expect(recs[0]!.message).toContain('save ~$18/mo');
  });

  it('uses the idle service attributed cost as its saving guess', () => {
    const idle: CostIdleServiceView = {
      serviceId: 's1',
      name: 'worker',
      stack: 'data',
      avgCpuPct: 0.8,
      windowDays: 7,
      estMonthlyUsd: 12.5,
    };
    const recs = buildRecommendations({ nodes: [], oversizedNodes: [], idleServices: [idle] });
    expect(recs[0]).toMatchObject({ id: 'idle-service:s1', kind: 'idle-service', savingsUsd: 12.5 });
    expect(recs[0]!.message).toContain('0.8% CPU over 7d');
  });

  it('sorts biggest saving first, setup nudges last', () => {
    const recs = buildRecommendations({
      nodes: [
        nodeView({ nodeId: 'n1', name: 'a-unpriced' }),
        nodeView({ nodeId: 'n2', name: 'gone', online: false, monthlyUsd: 100 }),
      ],
      oversizedNodes: [
        { nodeId: 'n3', name: 'big', avgCpuPct: 5, avgMemPct: 6, monthlyUsd: 36, windowDays: 7 },
      ],
      idleServices: [
        { serviceId: 's1', name: 'idle', stack: 'x', avgCpuPct: 1, windowDays: 7, estMonthlyUsd: null },
      ],
    });
    expect(recs.map((r) => r.kind)).toEqual([
      'offline-node', // $100
      'oversized-node', // $18
      'unpriced-node', // no guess → alphabetical by resource
      'idle-service',
    ]);
  });
});
