import { describe, expect, it } from 'bun:test';
import { replicationPrecheck, sameWriter, selectBootSource, type BootFacts, type WriterMarker } from './restore-select';

const A: WriterMarker = { holder: 'task-a', epoch: 3, hostname: 'mgr-1' };
const B: WriterMarker = { holder: 'task-b', epoch: 4, hostname: 'mgr-2' };

function facts(over: {
  local?: Partial<BootFacts['local']>;
  replica?: Partial<BootFacts['replica']>;
  bundle?: boolean;
  priorController?: boolean;
  forced?: BootFacts['forced'];
  allowFresh?: boolean;
}): BootFacts {
  return {
    local: { exists: false, marker: null, ...over.local },
    replica: { configured: false, reachable: false, hasData: false, marker: null, ...over.replica },
    bundle: { configured: over.bundle ?? false },
    priorController: over.priorController ?? false,
    ...(over.forced ? { forced: over.forced } : {}),
    ...(over.allowFresh ? { allowFresh: true } : {}),
  };
}
const replica = (marker: WriterMarker | null, hasData = true) => ({ configured: true, reachable: true, hasData, marker });

describe('selectBootSource', () => {
  it('empty volume + replica with data → restore from the replica', () => {
    expect(selectBootSource(facts({ replica: replica(B) })).kind).toBe('restore-replica');
  });

  it('empty volume, no replica, bundle configured → restore the bundle', () => {
    expect(selectBootSource(facts({ bundle: true })).kind).toBe('restore-bundle');
  });

  it('empty volume, replica configured but empty, bundle configured → bundle', () => {
    expect(selectBootSource(facts({ replica: replica(null, false), bundle: true })).kind).toBe('restore-bundle');
  });

  it('nothing anywhere on a first boot → start fresh', () => {
    expect(selectBootSource(facts({})).kind).toBe('fresh');
  });

  it('nothing anywhere but a controller ran before → refuse (unless SWARMY_ALLOW_FRESH)', () => {
    expect(selectBootSource(facts({ priorController: true })).kind).toBe('refuse');
    expect(selectBootSource(facts({ priorController: true, allowFresh: true })).kind).toBe('fresh');
  });

  it('empty volume and the replica is unreachable → wait, never start empty', () => {
    const d = selectBootSource(facts({ replica: { configured: true, reachable: false }, bundle: true }));
    expect(d.kind).toBe('wait');
  });

  it('local file of the replica’s current lineage → keep it (it may be ahead of the replica)', () => {
    expect(selectBootSource(facts({ local: { exists: true, marker: B }, replica: replica(B) })).kind).toBe('keep-local');
  });

  it('local file from an older lineage (controller moved away and back) → move aside + restore', () => {
    const d = selectBootSource(facts({ local: { exists: true, marker: A }, replica: replica(B) }));
    expect(d).toMatchObject({ kind: 'restore-replica', moveAsideLocal: true });
    expect(d.reason).toContain('stale');
  });

  it('local file with no marker while the replica has a marked lineage → stale', () => {
    expect(selectBootSource(facts({ local: { exists: true, marker: null }, replica: replica(B) })).kind).toBe('restore-replica');
  });

  it('local file and replica configured but still empty → keep local (we become its first writer)', () => {
    expect(selectBootSource(facts({ local: { exists: true, marker: null }, replica: replica(null, false) })).kind).toBe('keep-local');
  });

  it('local file and the replica unreachable → keep local (replication is re-checked before it starts)', () => {
    expect(selectBootSource(facts({ local: { exists: true, marker: A }, replica: { configured: true, reachable: false } })).kind).toBe(
      'keep-local',
    );
  });

  it('local file, no replica configured → keep local, even with a bundle', () => {
    expect(selectBootSource(facts({ local: { exists: true }, bundle: true })).kind).toBe('keep-local');
  });

  it('operator overrides win', () => {
    expect(selectBootSource(facts({ local: { exists: true, marker: B }, replica: replica(B), forced: 'replica' }))).toMatchObject({
      kind: 'restore-replica',
      moveAsideLocal: true,
    });
    expect(selectBootSource(facts({ forced: 'bundle' })).kind).toBe('restore-bundle');
    expect(selectBootSource(facts({ local: { exists: true }, forced: 'fresh' }))).toMatchObject({ kind: 'fresh', moveAsideLocal: true });
  });
});

describe('sameWriter', () => {
  it('compares holder and epoch only', () => {
    expect(sameWriter(A, { ...A, at: 99, hostname: 'x' })).toBe(true);
    expect(sameWriter(A, { ...A, epoch: 4 })).toBe(false);
    expect(sameWriter(null, null)).toBe(true);
    expect(sameWriter(A, null)).toBe(false);
  });
});

describe('replicationPrecheck (after taking the lease)', () => {
  it('passes when the replica is exactly what boot saw', () => {
    expect(replicationPrecheck({ bootMarker: B, bootHeadTxid: 40n, nowMarker: B, nowHeadTxid: 40n })).toEqual({ ok: true });
  });
  it('fails when the old writer shipped more after our restore (partition)', () => {
    const r = replicationPrecheck({ bootMarker: B, bootHeadTxid: 40n, nowMarker: B, nowHeadTxid: 41n });
    expect(r.ok).toBe(false);
  });
  it('fails when another controller took over the replica meanwhile', () => {
    expect(replicationPrecheck({ bootMarker: A, bootHeadTxid: 40n, nowMarker: B, nowHeadTxid: 40n }).ok).toBe(false);
  });
  it('first writer on an empty replica passes', () => {
    expect(replicationPrecheck({ bootMarker: null, bootHeadTxid: 0n, nowMarker: null, nowHeadTxid: 0n }).ok).toBe(true);
  });
});
