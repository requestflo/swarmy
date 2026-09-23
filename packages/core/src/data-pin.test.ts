import { describe, expect, it } from 'bun:test';
import {
  applyDataPin,
  CACHE_PIN_NODE_LABEL,
  dataPinLabel,
  pinnedDataCounts,
  pinPlacement,
  planDataPin,
  SEARCH_PIN_NODE_LABEL,
  VECTOR_PIN_NODE_LABEL,
} from './data-pin';
import { choosePinNode, DB_PIN_NODE_LABEL } from './manageddb-storage';

describe('data pin labels', () => {
  it('is swarmy.<kind>.node for every kind (db shares the scheme)', () => {
    expect(CACHE_PIN_NODE_LABEL).toBe('swarmy.cache.node');
    expect(SEARCH_PIN_NODE_LABEL).toBe('swarmy.search.node');
    expect(VECTOR_PIN_NODE_LABEL).toBe('swarmy.vector.node');
    expect(dataPinLabel('db')).toBe(DB_PIN_NODE_LABEL);
  });
});

describe('pinPlacement / applyDataPin', () => {
  it('pins, replacing stale node.id constraints and keeping others', () => {
    expect(
      pinPlacement(
        { constraints: ['node.labels.swarmy.region==eu', 'node.id==stale', 'node.id!=x'], preferences: ['spread=node.id'] },
        { pin: 'n1', onePerNode: true },
      ),
    ).toEqual({
      constraints: ['node.labels.swarmy.region==eu', 'node.id==n1'],
      preferences: ['spread=node.id'],
      maxReplicasPerNode: 1,
    });
  });

  it('avoid only applies to unpinned (replica) members', () => {
    expect(pinPlacement(undefined, { avoid: 'n1' })).toEqual({ constraints: ['node.id!=n1'] });
    expect(pinPlacement(undefined, { pin: 'n2', avoid: 'n1' })).toEqual({ constraints: ['node.id==n2'] });
  });

  it('is idempotent and a no-op without options', () => {
    const once = applyDataPin({ placement: { constraints: ['a==b'] } }, { pin: 'n1', onePerNode: true });
    expect(applyDataPin(once, { pin: 'n1', onePerNode: true })).toEqual(once);
    const bare = { mounts: [] };
    expect(applyDataPin(bare, {})).toBe(bare);
  });
});

describe('pinnedDataCounts — spread pins across every data kind', () => {
  it('counts db, cache, search and vector pins together', () => {
    const counts = pinnedDataCounts([
      { labels: { [DB_PIN_NODE_LABEL]: 'n1' } },
      { labels: { [CACHE_PIN_NODE_LABEL]: 'n1' } },
      { labels: { [SEARCH_PIN_NODE_LABEL]: 'n2' } },
      { labels: { 'swarmy.cache.avoidNode': 'n3' } },
      { labels: {} },
    ]);
    expect([...counts.entries()].sort()).toEqual([
      ['n1', 2],
      ['n2', 1],
    ]);
  });

  it('provision prefers a node not already hosting a pinned data member', () => {
    const node = (id: string, role: 'manager' | 'worker' = 'worker') => ({
      swarmNodeId: id,
      role,
      availability: 'active' as const,
      status: 'ready' as const,
    });
    const pin = choosePinNode({
      nodes: [node('m1', 'manager'), node('w1'), node('w2')],
      pinnedCounts: pinnedDataCounts([
        { labels: { [DB_PIN_NODE_LABEL]: 'm1' } },
        { labels: { [CACHE_PIN_NODE_LABEL]: 'w1' } },
      ]),
      fallback: 'm1',
    });
    expect(pin).toBe('w2');
  });
});

describe('planDataPin — adopt where it runs, never guess', () => {
  const L = CACHE_PIN_NODE_LABEL;
  it('pinned stays pinned (no work)', () => {
    expect(planDataPin({ labels: { [L]: 'n1' }, pinLabel: L, runningNodes: ['n2'] })).toEqual({
      kind: 'pinned',
      pin: 'n1',
    });
  });
  it('unpinned + running on one node → adopt that node', () => {
    expect(planDataPin({ labels: {}, pinLabel: L, runningNodes: ['n2', 'n2'] })).toEqual({
      kind: 'adopt',
      pin: 'n2',
    });
  });
  it('unpinned + not running → unplaced (warn), never a guess', () => {
    const plan = planDataPin({ labels: {}, pinLabel: L, runningNodes: [undefined] });
    expect(plan.kind).toBe('unplaced');
    expect(plan.kind === 'unplaced' && plan.reason).toBe('not-running');
  });
  it('unpinned + running on several nodes → unplaced (ambiguous)', () => {
    const plan = planDataPin({ labels: {}, pinLabel: L, runningNodes: ['n1', 'n2'] });
    expect(plan.kind === 'unplaced' && plan.reason).toBe('ambiguous');
  });
});
