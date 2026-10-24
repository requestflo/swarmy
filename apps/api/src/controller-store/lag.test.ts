import { describe, expect, it } from 'bun:test';
import { MAX_SEEN, emptyLag, noteLocal, noteReplica, noteReplicaError, readLag, type LagState } from './lag';

/** Feed (local, replica?) samples at 1 s steps from t = 0. */
function run(samples: Array<[local: number, replica?: number | 'fail']>): LagState {
  let s = emptyLag();
  samples.forEach(([local, replica], i) => {
    const t = i * 1000;
    s = noteLocal(s, BigInt(local), t);
    if (replica === 'fail') s = noteReplicaError(s, 'connect ECONNREFUSED');
    else if (replica !== undefined) s = noteReplica(s, BigInt(replica), t);
  });
  return s;
}

describe('replication lag (the "replicated (lag Ns)" figure)', () => {
  it('is unknown until the replica has been read once', () => {
    expect(readLag(run([[5], [6]]), 2000)).toMatchObject({ lagMs: null, behindTxns: null, replicaCheckedAgoMs: null });
  });

  it('is 0 when the replica holds everything local had at the read, even when idle for hours', () => {
    const s = run([[7, 7]]);
    expect(readLag(s, 6 * 3_600_000)).toMatchObject({ lagMs: 0, behindTxns: 0, replicaCheckedAgoMs: 6 * 3_600_000 });
  });

  it('a busy store a second behind reads about a second, not the time since the last read', () => {
    // Local moves every second; the replica, read every 5 s, trails by one TXID.
    const s = run([[10, 9], [11], [12], [13], [14], [15, 14]]);
    const r = readLag(s, 9000);
    expect(r.lagMs).toBe(0); // 15 was first seen at the read itself
    expect(r.behindTxns).toBe(1);
    const t = run([[10, 9], [11], [12], [13], [14], [15, 13]]);
    expect(readLag(t, 9000)).toMatchObject({ lagMs: 1000, behindTxns: 2 });
  });

  it('a stalled replica (reads fine, head stuck) shows the age of the oldest unshipped write', () => {
    const s = run([[10, 10], [11], [12], [13], [14], [15, 10], [16], [17], [18], [19], [20, 10]]);
    expect(readLag(s, 10_500)).toMatchObject({ lagMs: 9000, behindTxns: 10 });
  });

  it('while replica reads fail, the lag keeps growing from the oldest write since the last good read', () => {
    const s = run([[10, 10], [11], [12, 'fail'], [13, 'fail']]);
    const r = readLag(s, 30_000);
    expect(r.replicaError).toContain('ECONNREFUSED');
    expect(r.lagMs).toBe(29_000); // 11 was first seen at t = 1 s
    expect(r.behindTxns).toBe(3);
    // An idle store with a failing replica has nothing unshipped as far as we know.
    expect(readLag(run([[10, 10], [10, 'fail']]), 60_000)).toMatchObject({ lagMs: 0, behindTxns: 0 });
  });

  it('a good read after an outage clears the error and prunes what shipped', () => {
    const s = run([[10, 10], [11], [12, 'fail'], [13, 13]]);
    expect(readLag(s, 3000)).toMatchObject({ lagMs: 0, behindTxns: 0, replicaError: null });
    expect(s.seen).toEqual([]);
  });

  it('keeps the oldest sample when the history hits its cap', () => {
    let s = noteReplica(emptyLag(), 0n, 0);
    for (let i = 1; i <= MAX_SEEN + 50; i++) s = noteLocal(s, BigInt(i), i * 1000);
    expect(s.seen.length).toBe(MAX_SEEN);
    expect(s.seen[0]).toEqual({ txid: 1n, at: 1000 });
    s = noteReplicaError(s, 'timeout');
    expect(readLag(s, (MAX_SEEN + 60) * 1000).lagMs).toBe((MAX_SEEN + 59) * 1000);
  });
});
