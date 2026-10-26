import { afterEach, describe, expect, it } from 'bun:test';
import { moveDbWriterOff, type DbWriterMoveDeps } from './dbWriterMove.service';
import { fakeSwitchover, type FakeOpts } from './manageddb-switchover.fake';
import { resetSwitchoverRuns } from './manageddb-switchover.runs';

/**
 * The retire flow's writer move rides the ONE planned switchover: the same
 * plan and pause/catch-up/promote, with only the rejoin (un-pinned, kept off
 * the server leaving) and the copy bookkeeping its own.
 */

afterEach(() => resetSwitchoverRuns());

const IN = { stack: 'shop', cluster: 'db', avoidNodeId: 'n1' };

function setup(o: FakeOpts = {}) {
  const f = fakeSwitchover({ promote: 'yes', ...o });
  Object.assign(f.primary.labels, { 'swarmy.db.replicas': '1', 'swarmy.db.node': 'sw-n1', 'swarmy.db.dataVolume': 'shop_db-primary-data' });
  const deps: DbWriterMoveDeps = { now: f.io.now, sleep: f.io.sleep, secret: () => 'x', io: f.io, setReplicas: async () => {}, setTopology: async () => {} };
  return { f, deps };
}

describe('moveDbWriterOff — the retire flow', () => {
  it('switches over through the shared runner, then rebuilds the old writer off the server', async () => {
    const { f, deps } = setup();
    const said: string[] = [];
    const res = await moveDbWriterOff(f.ctx, IN, deps, (m) => said.push(m));
    expect(res).toEqual({ kind: 'moved', promoted: 'shop_db-replica', demoted: 'shop_db-primary', addedReplica: false });
    // The shared pause: read-only, open writes ended, then the final position.
    expect(f.sql.some((q) => q.endsWith('ALTER SYSTEM SET default_transaction_read_only = on'))).toBe(true);
    expect(f.calls.filter((c) => c.cmd === 'service.scale').map((c) => `${c.payload.service}→${c.payload.replicas}`)).toEqual(['shop_db-primary→0']);
    const spec = f.calls.find((c) => c.cmd === 'service.deploy')!.payload.spec as { name: string; labels: Record<string, string>; placement: { constraints: string[] } };
    expect(spec.name).toBe('shop_db-primary');
    expect(spec.labels['swarmy.db.node']).toBeUndefined();
    expect(spec.labels['swarmy.db.switchover']).toBeUndefined();
    expect(spec.labels['swarmy.db.avoidNode']).toBe('sw-n2');
    expect(spec.placement.constraints).toContain('node.id!=sw-n1');
    expect(said.some((m) => m.includes('takes the writes'))).toBe(true);
    expect(f.audit.filter((a) => a.startsWith('db.'))).toEqual(['db.switchover.start', 'db.switchover']);
  });

  it('an app wired straight to the writer: refused for the operator to settle, nothing touched', async () => {
    const { f, deps } = setup({ app: 'direct' });
    const res = await moveDbWriterOff(f.ctx, IN, deps);
    expect(res).toMatchObject({ kind: 'refused' });
    if (res.kind === 'refused') expect(res.reason).toContain('pooler');
    expect(f.calls.every((c) => c.cmd === 'db.query')).toBe(true);
    expect(f.sql).toEqual([]);
  });

  it('a copy that never catches up while writes continue gives up before anything is paused', async () => {
    const { f, deps } = setup({ row: { state: 'streaming', lagBytes: 64 << 20 } });
    await expect(moveDbWriterOff(f.ctx, IN, deps)).rejects.toThrow('gave up after 15 minutes');
    expect(f.sql).toEqual([]);
  });

  it('a held promotion gives the writes back and fails the step', async () => {
    const { f, deps } = setup({ promote: 'hold' });
    await expect(moveDbWriterOff(f.ctx, IN, deps)).rejects.toThrow('held the switch');
    expect(f.frozen()).toBe(false);
    expect(f.calls.some((c) => c.cmd === 'service.deploy')).toBe(false);
  });
});
