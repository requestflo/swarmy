import { describe, expect, it } from 'bun:test';
import { ControllerServiceMsg, isControllerPlacementConstraint, parseLeaseLabel, sameLeaseWrite } from './controllerService';
import { ControllerToAgentMessage } from './messages';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

describe('controllerService wire message', () => {
  it('every op round-trips through the ControllerToAgentMessage union', () => {
    const ops = [
      { kind: 'lease.acquire', holder: 't', node: 'n', ttlMs: 30000, expect: null, minEpoch: 2 },
      { kind: 'lease.renew', holder: 't', node: 'n', ttlMs: 30000, epoch: 3 },
      { kind: 'lease.release', holder: 't', epoch: 3 },
      { kind: 'configure', storeSecret: 'swarmy_control_store.1', placement: 'floating' },
      { kind: 'move', targetNodeId: 'n2', fromNodeId: 'n1' },
      { kind: 'move.clear' },
    ];
    for (const op of ops) {
      const msg = { type: 'controllerService', payload: { commandId: CMD_ID, service: 'swarmy_controller', op } };
      expect(ControllerServiceMsg.safeParse(msg).success).toBe(true);
      const parsed = ControllerToAgentMessage.safeParse(msg);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data))).toMatchObject(msg);
    }
  });

  it('rejects an unknown op', () => {
    const r = ControllerToAgentMessage.safeParse({
      type: 'controllerService',
      payload: { commandId: CMD_ID, service: 's', op: { kind: 'lease.steal' } },
    });
    expect(r.success).toBe(false);
  });
});

describe('lease label', () => {
  it('parses valid JSON and treats anything else as no lease', () => {
    const r = { holder: 't', node: 'n', epoch: 1, renewedAt: 5, ttlMs: 30000 };
    expect(parseLeaseLabel(JSON.stringify(r))).toEqual(r);
    expect(parseLeaseLabel('')).toBeNull();
    expect(parseLeaseLabel('{nope')).toBeNull();
    expect(parseLeaseLabel(JSON.stringify({ holder: 't' }))).toBeNull();
  });
  it('sameLeaseWrite distinguishes renewals and releases', () => {
    const r = { holder: 't', node: 'n', epoch: 1, renewedAt: 5, ttlMs: 30000 };
    expect(sameLeaseWrite(r, { ...r })).toBe(true);
    expect(sameLeaseWrite(r, { ...r, renewedAt: 6 })).toBe(false);
    expect(sameLeaseWrite(r, { ...r, released: true })).toBe(false);
    expect(sameLeaseWrite(null, null)).toBe(true);
  });
  it('recognises the placement constraints the ops own', () => {
    expect(isControllerPlacementConstraint('node.hostname == a')).toBe(true);
    expect(isControllerPlacementConstraint('node.role==manager')).toBe(true);
    expect(isControllerPlacementConstraint('node.labels.x == y')).toBe(false);
  });
});

describe('casLossReason (QA-022)', () => {
  it('a lost CAS on a lease that is still ours is a conflict, not a loss', async () => {
    const { casLossReason } = await import('./controllerService');
    const renew = { kind: 'lease.renew', holder: 't', epoch: 6 } as const;
    const lease = { holder: 't', node: 'n', epoch: 6, renewedAt: 1, ttlMs: 60_000 };
    expect(casLossReason(renew, lease)).toBe('conflict');
    expect(casLossReason(renew, { ...lease, holder: 'u' })).toBe('lost');
    expect(casLossReason(renew, { ...lease, epoch: 7 })).toBe('lost');
    expect(casLossReason(renew, null)).toBe('lost');
    expect(casLossReason({ kind: 'lease.acquire', holder: 't' }, lease)).toBe('conflict');
  });
});
