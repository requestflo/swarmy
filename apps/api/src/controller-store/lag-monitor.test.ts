import { describe, expect, it } from 'bun:test';
import { LagMonitor, REPLICA_EVERY, type LagSources } from './lag-monitor';

function fake(opts: { local: Array<bigint | Error>; head: Array<bigint | Error> }) {
  let li = 0;
  let hi = 0;
  const calls = { local: 0, head: 0 };
  const src: LagSources = {
    async local() {
      calls.local++;
      const v = opts.local[Math.min(li++, opts.local.length - 1)]!;
      if (v instanceof Error) throw v;
      return v;
    },
    async replicaHead() {
      calls.head++;
      const v = opts.head[Math.min(hi++, opts.head.length - 1)]!;
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return { src, calls };
}

describe('LagMonitor', () => {
  it('reads the replica on the first good sample, then every REPLICA_EVERY samples', async () => {
    let t = 0;
    const { src, calls } = fake({ local: [5n], head: [5n] });
    const m = new LagMonitor(src, () => t);
    for (let i = 0; i < REPLICA_EVERY * 2 + 1; i++, t += 1000) await m.sample();
    expect(calls.local).toBe(REPLICA_EVERY * 2 + 1);
    expect(calls.head).toBe(3);
    expect(m.reading()).toMatchObject({ lagMs: 0, behindTxns: 0, localError: null });
  });

  it('never reads the replica without a fresh local position, and says why', async () => {
    const { src, calls } = fake({ local: [new Error('litestream /txid timed out')], head: [1n] });
    const m = new LagMonitor(src, () => 0);
    await m.sample();
    await m.sample();
    expect(calls.head).toBe(0);
    expect(m.reading()).toMatchObject({ lagMs: null, localError: 'litestream /txid timed out' });
  });

  it('a due replica read waits for the next good local sample instead of being skipped', async () => {
    const { src, calls } = fake({ local: [new Error('down'), 7n], head: [7n] });
    const m = new LagMonitor(src, () => 0);
    await m.sample();
    await m.sample();
    expect(calls.head).toBe(1);
    expect(m.reading().lagMs).toBe(0);
  });

  it('an unreadable bucket is reported, and the lag grows from the oldest unshipped write', async () => {
    let t = 0;
    const { src } = fake({ local: [10n, 11n, 12n, 13n, 14n, 15n], head: [10n, new Error('NoSuchBucket')] });
    const m = new LagMonitor(src, () => t);
    for (let i = 0; i <= REPLICA_EVERY; i++, t += 1000) await m.sample();
    const r = m.reading();
    expect(r.replicaError).toBe('NoSuchBucket');
    expect(r.lagMs).toBe(t - 1000); // 11 was first seen at t = 1 s
  });
});
