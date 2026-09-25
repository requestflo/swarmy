import { describe, expect, it } from 'bun:test';
import { localBehindLease, selectBootSource, type BootFacts, type WriterMarker } from './restore-select';

/** QA-060: never keep a local file older than the lease epoch in raft while the replica is down. */
const mine: WriterMarker = { holder: 'task-b-old', epoch: 11, node: 'node-b', hostname: 'lon1-b' };
const base = (over: Partial<BootFacts>): BootFacts => ({
  local: { exists: true, marker: mine },
  replica: { configured: true, reachable: false, hasData: false, marker: null },
  bundle: { configured: false },
  priorController: true,
  selfNode: 'node-b',
  ...over,
});

describe('boot with the replica unreachable', () => {
  it('the rebooted node behind the lease (epochs 12–13 ran elsewhere) waits instead of serving', () => {
    const d = selectBootSource(base({ lease: { epoch: 13, node: 'node-a', hostname: 'lon1-a' } }));
    expect(d.kind).toBe('wait');
    expect(d.reason).toContain('epoch 11');
    expect(d.reason).toContain('epoch 13 on lon1-a');
  });

  it('a later epoch taken on THIS node is its own writer: keep the local file', () => {
    expect(selectBootSource(base({ lease: { epoch: 12, node: 'node-b' } })).kind).toBe('keep-local');
  });

  it('the lease at the file’s epoch (or no lease known) keeps the local file, as before', () => {
    expect(selectBootSource(base({ lease: { epoch: 11, node: 'node-a' } })).kind).toBe('keep-local');
    expect(selectBootSource(base({ lease: null })).kind).toBe('keep-local');
  });

  it('an unmarked local file counts as epoch 0', () => {
    expect(localBehindLease(null, { epoch: 1, node: 'node-a' }, 'node-b')).toContain('epoch 0');
  });

  it('with the replica reachable, lineage decides (restore when markers differ), the lease rule does not interfere', () => {
    const d = selectBootSource(
      base({ replica: { configured: true, reachable: true, hasData: true, marker: { holder: 'task-a', epoch: 13 } }, lease: { epoch: 13, node: 'node-a' } }),
    );
    expect(d).toMatchObject({ kind: 'restore-replica', moveAsideLocal: true });
  });

  it('no replica configured (a pinned store): nothing to wait for, keep-local', () => {
    expect(selectBootSource(base({ replica: { configured: false, reachable: false, hasData: false, marker: null }, lease: { epoch: 13, node: 'node-a' } })).kind).toBe(
      'keep-local',
    );
  });
});
