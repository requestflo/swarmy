import { describe, expect, it } from 'bun:test';
import {
  backoffTicks,
  buildStats,
  matchGarageNodes,
  mergeNodeMapping,
  parseAdminOutput,
  parseGarageHealth,
  parseGarageLayout,
  parseGarageStatus,
  planLayout,
  planSignature,
  statsChanged,
  zoneFor,
  STATUS_MARKER,
  type GarageLayout,
  type GarageNodeStatus,
} from './storage-reconcile.core';

const gnode = (over: Partial<GarageNodeStatus> & { id: string }): GarageNodeStatus => ({
  hostname: null,
  isUp: true,
  draining: false,
  role: null,
  dataAvailableBytes: null,
  dataTotalBytes: null,
  ...over,
});

const layout = (over: Partial<GarageLayout> = {}): GarageLayout => ({
  version: 3,
  roles: [],
  staged: [],
  ...over,
});

describe('parseAdminOutput', () => {
  it('splits the status marker from the body', () => {
    expect(parseAdminOutput(`${STATUS_MARKER}200\n{"ok":true}`)).toEqual({
      status: 200,
      body: '{"ok":true}',
    });
  });

  it('reports status 0 when the marker is missing (curl failed)', () => {
    expect(parseAdminOutput('connection refused').status).toBe(0);
  });
});

describe('parseGarageStatus / parseGarageLayout / parseGarageHealth', () => {
  it('normalizes a v1 status payload', () => {
    const s = parseGarageStatus({
      node: 'aaa',
      layoutVersion: 7,
      nodes: [
        {
          id: 'aaa',
          hostname: 'abc123def456',
          isUp: true,
          draining: false,
          role: { id: 'aaa', zone: 'node-n1', capacity: 100_000_000_000, tags: [] },
          dataPartition: { available: 50, total: 100 },
        },
        { id: 'bbb', hostname: 'ffff00001111', isUp: false, role: null },
        { bogus: true },
      ],
    });
    expect(s.node).toBe('aaa');
    expect(s.layoutVersion).toBe(7);
    expect(s.nodes).toHaveLength(2);
    expect(s.nodes[0]).toEqual({
      id: 'aaa',
      hostname: 'abc123def456',
      isUp: true,
      draining: false,
      role: { zone: 'node-n1', capacity: 100_000_000_000 },
      dataAvailableBytes: 50,
      dataTotalBytes: 100,
    });
    expect(s.nodes[1]!.isUp).toBe(false);
    expect(s.nodes[1]!.role).toBeNull();
  });

  it('parses layout roles + staged changes and rejects junk', () => {
    const l = parseGarageLayout({
      version: 12,
      roles: [{ id: 'aaa', zone: 'node-n1', capacity: 5 }],
      stagedRoleChanges: [
        { id: 'bbb', zone: 'node-n2', capacity: 9, tags: ['org:o1'] },
        { id: 'ccc', remove: true },
        { nope: 1 },
      ],
    });
    expect(l).toEqual({
      version: 12,
      roles: [{ id: 'aaa', zone: 'node-n1', capacity: 5 }],
      staged: [
        { id: 'bbb', zone: 'node-n2', capacity: 9, tags: ['org:o1'] },
        { id: 'ccc', remove: true },
      ],
    });
    expect(parseGarageLayout({ roles: [] })).toBeNull();
    expect(parseGarageLayout('nope')).toBeNull();
  });

  it('parses health and defaults missing counters to 0', () => {
    expect(
      parseGarageHealth({ status: 'degraded', partitions: 256, partitionsAllOk: 100 }),
    ).toEqual({
      status: 'degraded',
      knownNodes: 0,
      connectedNodes: 0,
      storageNodes: 0,
      storageNodesOk: 0,
      partitions: 256,
      partitionsQuorum: 0,
      partitionsAllOk: 100,
    });
    expect(parseGarageHealth({})).toBeNull();
  });
});

describe('matchGarageNodes', () => {
  it('maps via layout zone, then container hostname, keeping known entries', () => {
    const mapping = matchGarageNodes(
      [
        gnode({ id: 'g1', role: { zone: zoneFor('n1'), capacity: 1 } }),
        gnode({ id: 'g2', hostname: 'cid2short0000' }),
        gnode({ id: 'g3' }),
      ],
      [{ nodeId: 'n2', containerIdShort: 'cid2short0000' }],
      { n3: 'g3' },
    );
    expect(mapping).toEqual({ n1: 'g1', n2: 'g2', n3: 'g3' });
  });

  it('drops known mappings whose garage node vanished', () => {
    expect(matchGarageNodes([gnode({ id: 'g1' })], [], { n1: 'gone' })).toEqual({});
  });

  it('falls back to the unambiguous singleton', () => {
    expect(
      matchGarageNodes(
        [gnode({ id: 'g9', hostname: 'nomatch' })],
        [{ nodeId: 'n1', containerIdShort: 'deadbeef0000' }],
        {},
      ),
    ).toEqual({ n1: 'g9' });
  });

  it('never claims one garage node for two swarmy nodes', () => {
    const mapping = matchGarageNodes(
      [gnode({ id: 'g1', hostname: 'aaa' })],
      [
        { nodeId: 'n1', containerIdShort: 'aaa' },
        { nodeId: 'n2', containerIdShort: 'aaa' },
      ],
      {},
    );
    expect(Object.values(mapping)).toEqual(['g1']);
  });
});

describe('mergeNodeMapping', () => {
  it('adds newly discovered members and reports change', () => {
    const { changed, next } = mergeNodeMapping({}, { n1: 'g1' }, 100);
    expect(changed).toBe(true);
    expect(next).toEqual({ nodes: { n1: { garageNodeId: 'g1', capacityGb: 100 } } });
  });

  it('is a no-op when the mapping is already recorded', () => {
    const existing = { nodes: { n1: { garageNodeId: 'g1', capacityGb: 250 } } };
    const { changed, next } = mergeNodeMapping(existing, { n1: 'g1' }, 100);
    expect(changed).toBe(false);
    expect((next.nodes as Record<string, { capacityGb: number }>).n1!.capacityGb).toBe(250);
  });
});

describe('planLayout (stage → apply)', () => {
  const desired = [
    { nodeId: 'n1', garageNodeId: 'g1', capacityGb: 100 },
    { nodeId: 'n2', garageNodeId: 'g2', capacityGb: 100 },
  ];
  const role = (id: string, node: string) => ({
    id,
    zone: zoneFor(node),
    capacity: 100_000_000_000,
  });

  it('stages joins for unassigned members and bumps the apply version', () => {
    const plan = planLayout('o1', desired, layout({ version: 3, roles: [role('g1', 'n1')] }));
    expect(plan.stage).toEqual([
      { id: 'g2', zone: 'node-n2', capacity: 100_000_000_000, tags: ['org:o1'] },
    ]);
    expect(plan.applyVersion).toBe(4);
    expect(plan.incompleteMapping).toBe(false);
  });

  it('is empty at steady state (a second tick dispatches nothing)', () => {
    const plan = planLayout('o1', desired, layout({ roles: [role('g1', 'n1'), role('g2', 'n2')] }));
    expect(plan.stage).toEqual([]);
    expect(plan.applyVersion).toBeNull();
  });

  it('stages removal of roles no longer in the member set', () => {
    const plan = planLayout(
      'o1',
      [desired[0]!],
      layout({ roles: [role('g1', 'n1'), role('gOld', 'nGone')] }),
    );
    expect(plan.stage).toEqual([{ id: 'gOld', remove: true }]);
    expect(plan.applyVersion).toBe(4);
  });

  it('withholds removals while any member is still undiscovered', () => {
    const plan = planLayout(
      'o1',
      [desired[0]!, { nodeId: 'n2', capacityGb: 100 }],
      layout({ roles: [role('g1', 'n1'), role('gMaybeN2', 'nGone')] }),
    );
    expect(plan.incompleteMapping).toBe(true);
    expect(plan.stage).toEqual([]);
    expect(plan.applyVersion).toBeNull();
  });

  it('re-stages a member whose capacity or zone drifted', () => {
    const plan = planLayout(
      'o1',
      [{ nodeId: 'n1', garageNodeId: 'g1', capacityGb: 200 }],
      layout({ roles: [role('g1', 'n1')] }),
    );
    expect(plan.stage).toEqual([
      { id: 'g1', zone: 'node-n1', capacity: 200_000_000_000, tags: ['org:o1'] },
    ]);
  });

  it('skips staging changes already staged verbatim, but still applies', () => {
    const plan = planLayout(
      'o1',
      desired,
      layout({
        roles: [role('g1', 'n1')],
        staged: [{ id: 'g2', zone: 'node-n2', capacity: 100_000_000_000, tags: ['org:o1'] }],
      }),
    );
    expect(plan.stage).toEqual([]);
    expect(plan.applyVersion).toBe(4);
  });
});

describe('planSignature / statsChanged / backoffTicks', () => {
  it('signature is stable for identical plans and differs when the plan changes', () => {
    const a = planLayout('o1', [{ nodeId: 'n1', garageNodeId: 'g1', capacityGb: 100 }], layout());
    const b = planLayout('o1', [{ nodeId: 'n1', garageNodeId: 'g1', capacityGb: 100 }], layout());
    const c = planLayout('o1', [{ nodeId: 'n1', garageNodeId: 'g1', capacityGb: 200 }], layout());
    expect(planSignature(a, 3)).toBe(planSignature(b, 3));
    expect(planSignature(a, 3)).not.toBe(planSignature(c, 3));
    expect(planSignature(a, 3)).not.toBe(planSignature(a, 4));
  });

  it('statsChanged ignores the timestamp but catches real drift', () => {
    const status = parseGarageStatus({
      node: 'g1',
      layoutVersion: 3,
      nodes: [{ id: 'g1', isUp: true }],
    });
    const health = parseGarageHealth({ status: 'healthy', partitions: 256, partitionsAllOk: 256 });
    const t1 = buildStats(status, health, { n1: 'g1' }, '2026-07-04T00:00:00Z');
    const t2 = buildStats(status, health, { n1: 'g1' }, '2026-07-04T00:00:30Z');
    expect(statsChanged(JSON.stringify(t1), t2)).toBe(false);
    const degraded = buildStats(
      status,
      parseGarageHealth({ status: 'degraded', partitions: 256, partitionsAllOk: 100 }),
      { n1: 'g1' },
      '2026-07-04T00:01:00Z',
    );
    expect(statsChanged(JSON.stringify(t1), degraded)).toBe(true);
    expect(statsChanged(undefined, t1)).toBe(true);
    expect(statsChanged('not-json', t1)).toBe(true);
  });

  it('backs off exponentially and caps at 8 ticks', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffTicks)).toEqual([0, 1, 2, 4, 8, 8, 8]);
  });
});
