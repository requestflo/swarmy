import { describe, expect, it } from 'bun:test';
import { MESH_LEASE } from '@swarmy/core/protocol';
import { MOVE_WINDOW, judgeMoveDrill, replicaFenceBoundMs, type MoveDrillObservation } from './move-drill';

const P = Date.parse('2026-10-24T12:00:00.000Z');
const good: MoveDrillObservation = {
  cleanMove: { restored: true, epochBefore: 3, epochAfter: 4, holderAfter: 'nodeB', target: 'nodeB', oldStillRuns: false },
  peers: { total: 3, connected: 3 },
  setupKeys: { mintedBefore: true, mintedAfter: true },
  partition: {
    partitionAt: P,
    oldReplicaStoppedAt: P + 47_000,
    oldReplicaExit: 137,
    newReplicaStartedAt: P + 47_000 + 25_000,
    epochBefore: 4,
    epochAfter: 5,
    holderAfter: 'nodeC',
    target: 'nodeC',
    oldStoppedAfterHeal: true,
    controlPlanesAfterHeal: 1,
  },
  moveBack: { used: 'replica', keptOldCopy: true, epochBefore: 5, epochAfter: 6, holderAfter: 'nodeA', target: 'nodeA', keyMintedAway: true },
};
const withPartition = (p: Partial<MoveDrillObservation['partition']>) => ({ ...good, partition: { ...good.partition, ...p } });

describe('mesh control-plane move drill verdict', () => {
  it('uses the lease the agent runs', () => {
    expect(MOVE_WINDOW).toEqual({ ttlMs: MESH_LEASE.ttlMs, renewEveryMs: MESH_LEASE.renewEveryMs, marginMs: MESH_LEASE.marginMs });
    // TTL − margin + 3 s skew.
    expect(replicaFenceBoundMs()).toBe(55_000);
  });

  it('a clean move, then a self-fence inside the window and a later takeover, passes', () => {
    expect(judgeMoveDrill(good)).toEqual({ ok: true, problems: [], fencedAfterMs: 47_000, handoverGapMs: 25_000 });
  });

  it('the clean move must restore, hand the lease over and leave nothing behind; peers and keys must work', () => {
    const v = judgeMoveDrill({
      ...good,
      cleanMove: { ...good.cleanMove, restored: false, holderAfter: 'nodeA', epochAfter: 3, oldStillRuns: true },
      peers: { total: 3, connected: 2 },
      setupKeys: { mintedBefore: false, mintedAfter: true },
    });
    expect(v.problems).toEqual([
      'clean move: the target did not restore from the replica (restored: false)',
      'clean move: the lease is held by nodeA, not the target nodeB',
      'clean move: the lease epoch did not move forward (3 → 3)',
      'clean move: the old node still runs swarmy-mesh-control',
      'peers: 2/3 re-attached to the moved control plane',
      'a setup key minted before the move no longer enrols a peer',
    ]);
  });

  it('a replica writer that never stopped, stopped late, or synced on its way out fails', () => {
    expect(judgeMoveDrill(withPartition({ oldReplicaStoppedAt: null, oldReplicaExit: null })).problems[0]).toBe("partition: the cut-off node's Litestream never stopped");
    expect(judgeMoveDrill(withPartition({ oldReplicaStoppedAt: P + 70_000, newReplicaStartedAt: P + 100_000 })).problems[0]).toBe(
      'partition: Litestream stopped 70s after the cut; the bound is 55s',
    );
    expect(judgeMoveDrill(withPartition({ oldReplicaExit: 0 })).problems).toEqual(['partition: the old Litestream exited 0, not 137 (killed, no final sync)']);
  });

  it('two writers at once, a stuck epoch, or two control planes after the heal fail', () => {
    expect(judgeMoveDrill(withPartition({ newReplicaStartedAt: P + 48_000 })).problems[0]).toContain('two writers?');
    expect(judgeMoveDrill(withPartition({ epochAfter: 4 })).problems).toEqual(['partition: the lease epoch did not move forward (4 → 4)']);
    expect(judgeMoveDrill(withPartition({ oldStoppedAfterHeal: false, controlPlanesAfterHeal: 2 })).problems).toEqual([
      'after the heal: the old node kept running swarmy-mesh-control',
      'after the heal: 2 control planes run, want 1',
    ]);
  });

  it('moving back must run the backup over the old copy, keep the old files and enrol a key minted while away', () => {
    const back = (b: Partial<MoveDrillObservation['moveBack']>) => judgeMoveDrill({ ...good, moveBack: { ...good.moveBack, ...b } }).problems;
    expect(back({ used: 'local', keyMintedAway: false })).toEqual([
      'move back: the first node ran its own old copy, not the backup',
      'move back: a setup key minted while the control plane was away does not enrol (stale state?)',
    ]);
    expect(back({ used: null, keptOldCopy: false, holderAfter: 'nodeC', epochAfter: 5 })).toEqual([
      'move back: the first node ran "nothing", not the backup',
      "move back: the first node's old files were not kept aside",
      'move back: the lease is held by nodeC, not the target nodeA',
      'move back: the lease epoch did not move forward (5 → 5)',
    ]);
  });
});
