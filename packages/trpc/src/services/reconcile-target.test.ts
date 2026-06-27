import { describe, expect, it } from 'bun:test';
import { selectRestoreTarget, type ReconcileNode } from './reconcile-target';

function n(id: string, role: 'MANAGER' | 'WORKER', online: boolean, assigned = 0): ReconcileNode {
  return { id, role, online, assignedRestores: assigned };
}

describe('DR reconcile target selection', () => {
  it('returns null when no healthy node is available', () => {
    expect(
      selectRestoreTarget({ deadNodeId: 'dead', nodes: [n('dead', 'MANAGER', false)] }),
    ).toBeNull();
  });

  it('never picks the dead node', () => {
    const pick = selectRestoreTarget({
      deadNodeId: 'dead',
      nodes: [n('dead', 'MANAGER', true), n('m1', 'MANAGER', true)],
    });
    expect(pick).toBe('m1');
  });

  it('prefers a manager over a worker', () => {
    const pick = selectRestoreTarget({
      deadNodeId: 'dead',
      nodes: [n('w1', 'WORKER', true), n('m1', 'MANAGER', true)],
    });
    expect(pick).toBe('m1');
  });

  it('balances by fewest assigned restores within a tier', () => {
    const pick = selectRestoreTarget({
      deadNodeId: 'dead',
      nodes: [n('m1', 'MANAGER', true, 2), n('m2', 'MANAGER', true, 0)],
    });
    expect(pick).toBe('m2');
  });

  it('breaks ties deterministically by id', () => {
    const pick = selectRestoreTarget({
      deadNodeId: 'dead',
      nodes: [n('mb', 'MANAGER', true, 0), n('ma', 'MANAGER', true, 0)],
    });
    expect(pick).toBe('ma');
  });

  it('falls back to a worker when no manager is online', () => {
    const pick = selectRestoreTarget({
      deadNodeId: 'dead',
      nodes: [n('m1', 'MANAGER', false), n('w1', 'WORKER', true)],
    });
    expect(pick).toBe('w1');
  });
});
