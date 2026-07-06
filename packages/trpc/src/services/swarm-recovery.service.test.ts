import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import {
  demoteRefusalReason,
  majorityOf,
  managerCensus,
  quorumVerdict,
} from './swarm-recovery.service';

function node(over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo {
  return {
    swarmNodeId: 'sn1',
    hostname: 'node-1',
    role: 'worker',
    availability: 'active',
    status: 'ready',
    leader: false,
    labels: {},
    ...over,
  };
}

describe('managerCensus', () => {
  it('counts managers and the ready subset only', () => {
    const census = managerCensus([
      node({ role: 'manager', status: 'ready' }),
      node({ role: 'manager', status: 'down' }),
      node({ role: 'manager', status: 'disconnected' }),
      node({ role: 'worker', status: 'ready' }),
    ]);
    expect(census).toEqual({ total: 3, reachable: 1 });
  });

  it('is zero on an empty estate', () => {
    expect(managerCensus([])).toEqual({ total: 0, reachable: 0 });
  });
});

describe('majorityOf', () => {
  it('is the raft majority floor(n/2)+1', () => {
    expect(majorityOf(1)).toBe(1);
    expect(majorityOf(2)).toBe(2);
    expect(majorityOf(3)).toBe(2);
    expect(majorityOf(4)).toBe(3);
    expect(majorityOf(5)).toBe(3);
    expect(majorityOf(7)).toBe(4);
  });
});

describe('quorumVerdict', () => {
  it('maps the census onto the five verdicts', () => {
    expect(quorumVerdict({ total: 0, reachable: 0 }).verdict).toBe('no-swarm');
    expect(quorumVerdict({ total: 1, reachable: 1 }).verdict).toBe('single-manager');
    expect(quorumVerdict({ total: 1, reachable: 0 }).verdict).toBe('single-manager');
    expect(quorumVerdict({ total: 3, reachable: 3 }).verdict).toBe('healthy');
    expect(quorumVerdict({ total: 3, reachable: 2 }).verdict).toBe('at-risk');
    expect(quorumVerdict({ total: 2, reachable: 2 }).verdict).toBe('at-risk');
    expect(quorumVerdict({ total: 3, reachable: 1 }).verdict).toBe('lost');
    expect(quorumVerdict({ total: 5, reachable: 2 }).verdict).toBe('lost');
    expect(quorumVerdict({ total: 5, reachable: 4 }).verdict).toBe('healthy');
  });

  it('speaks plainly about the at-risk case', () => {
    expect(quorumVerdict({ total: 3, reachable: 2 }).message).toBe(
      'You have 3 managers but 1 is offline — one more failure loses quorum.',
    );
  });
});

describe('demoteRefusalReason — the quorum guard', () => {
  it('refuses demoting the last manager outright, in plain words', () => {
    const reason = demoteRefusalReason({ total: 1, reachable: 1 }, true);
    expect(reason).toContain('only manager');
    expect(reason).toContain('Promote another node first');
  });

  it('refuses a demote that would leave 0 managers even when unreachable', () => {
    expect(demoteRefusalReason({ total: 1, reachable: 0 }, false)).not.toBeNull();
  });

  it('allows demoting one of two reachable managers (1 of 1 remaining)', () => {
    expect(demoteRefusalReason({ total: 2, reachable: 2 }, true)).toBeNull();
  });

  it('refuses demoting the reachable manager of a 2-manager set with one down', () => {
    // Remaining set = 1 manager, 0 reachable → below majority 1.
    expect(demoteRefusalReason({ total: 2, reachable: 1 }, true)).not.toBeNull();
  });

  it('allows demoting the UNREACHABLE manager of a 2-manager set', () => {
    // Remaining set = 1 reachable manager of 1 → majority holds.
    expect(demoteRefusalReason({ total: 2, reachable: 1 }, false)).toBeNull();
  });

  it('allows a healthy 3-manager set to drop to 2', () => {
    expect(demoteRefusalReason({ total: 3, reachable: 3 }, true)).toBeNull();
  });

  it('refuses when 3 managers already run with one offline (remaining 2 need 2)', () => {
    // Demote a reachable one: remaining = 2 managers, 1 reachable < majority 2.
    expect(demoteRefusalReason({ total: 3, reachable: 2 }, true)).not.toBeNull();
    // Demote the offline one instead: remaining = 2, 2 reachable — fine.
    expect(demoteRefusalReason({ total: 3, reachable: 2 }, false)).toBeNull();
  });

  it('handles 5 and 7 manager sets at the boundary', () => {
    // 5 managers, 3 reachable: demoting a reachable one → 2 of 4 < 3.
    expect(demoteRefusalReason({ total: 5, reachable: 3 }, true)).not.toBeNull();
    // Demoting an offline one → 3 of 4 ≥ 3.
    expect(demoteRefusalReason({ total: 5, reachable: 3 }, false)).toBeNull();
    // 7 managers, 4 reachable: demoting reachable → 3 of 6 < 4.
    expect(demoteRefusalReason({ total: 7, reachable: 4 }, true)).not.toBeNull();
    expect(demoteRefusalReason({ total: 7, reachable: 4 }, false)).toBeNull();
  });
});
