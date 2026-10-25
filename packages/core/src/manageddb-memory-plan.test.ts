import { describe, expect, it } from 'bun:test';
import { memMemberOf, memSignature, planPgMemory, type MemMember } from './manageddb-memory-plan';

/** The writer is never the first copy restarted, and never before its standbys are back. */

const m = (service: string, phase: MemMember['phase'], over: Partial<MemMember> = {}): MemMember => ({
  service, phase, appliedMb: null, desired: 1, running: 1, updating: false, verified: false, ...over,
});

describe('planPgMemory', () => {
  it('restarts every stale standby first, with the new size', () => {
    const step = planPgMemory({ wantedMb: 2048, writersRedeployable: true, members: [m('p', 'writer'), m('r', 'standby'), m('r-eu', 'standby')] });
    expect(step).toEqual({ kind: 'restart', phase: 'standby', services: ['r', 'r-eu'], memoryMb: 2048 });
  });

  it('waits for the standbys to be back and verified before the writer', () => {
    const members = [m('p', 'writer'), m('r', 'standby', { appliedMb: 2048, running: 0 })];
    expect(planPgMemory({ wantedMb: 2048, writersRedeployable: true, members })).toEqual({ kind: 'verify', phase: 'standby', services: ['r'], memoryMb: 2048 });
    members[1] = m('r', 'standby', { appliedMb: 2048, verified: false });
    expect(planPgMemory({ wantedMb: 2048, writersRedeployable: true, members }).kind).toBe('verify');
  });

  it('then restarts the writer in place', () => {
    const members = [m('p', 'writer'), m('r', 'standby', { appliedMb: 2048, verified: true })];
    expect(planPgMemory({ wantedMb: 2048, writersRedeployable: true, members })).toEqual({ kind: 'restart', phase: 'writer', services: ['p'], memoryMb: 2048 });
  });

  it('a single copy restarts its writer straight away; temporary storage never restarts', () => {
    expect(planPgMemory({ wantedMb: 512, writersRedeployable: true, members: [m('p', 'writer')] }).kind).toBe('restart');
    expect(planPgMemory({ wantedMb: 512, writersRedeployable: false, members: [m('p', 'writer')] })).toMatchObject({ kind: 'blocked' });
  });

  it('steady once every copy has the declared size (and clearing it rolls back to no limit)', () => {
    expect(planPgMemory({ wantedMb: 512, writersRedeployable: true, members: [m('p', 'writer', { appliedMb: 512 }), m('r', 'standby', { appliedMb: 512 })] })).toEqual({ kind: 'steady' });
    expect(planPgMemory({ wantedMb: null, writersRedeployable: true, members: [m('p', 'writer', { appliedMb: 512 }), m('r', 'standby', { appliedMb: 512 })] })).toEqual({
      kind: 'restart', phase: 'standby', services: ['r'], memoryMb: null,
    });
  });
});

describe('memMemberOf / memSignature', () => {
  it('reads the applied label and the update state; the signature ignores verification', () => {
    const svc = { name: 'p', labels: { 'swarmy.db.memoryMb.applied': '1024' }, desiredReplicas: 1, runningReplicas: 1, updateStatus: 'updating' };
    const a = memMemberOf(svc, 'writer', false);
    expect([a.appliedMb, a.updating]).toEqual([1024, true]);
    const sig = (verified: boolean) => memSignature({ wantedMb: 1024, writersRedeployable: true, members: [memMemberOf(svc, 'writer', verified)] });
    expect(sig(true)).toBe(sig(false));
  });
});
