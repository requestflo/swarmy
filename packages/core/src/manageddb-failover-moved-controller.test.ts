import { describe, expect, it } from 'bun:test';
import { decideFailover, encodeFailoverConfirmation, parseFailoverConfirmation, type DecideFailoverInput } from './manageddb-failover';

/**
 * The promotion decision after the CONTROLLER itself moved (P3), e.g. the
 * node that held both the primary and the controller died. The new controller
 * process has no in-memory history: no watermark and no last-healthy time. It
 * can't prove any replica is caught up, so it must hold for an admin, never
 * promote silently and never give up. The handshake lives in service labels
 * (swarm raft), so a confirmation made on the new controller promotes.
 */
const movedController = (over: Partial<DecideFailoverInput> = {}): DecideFailoverInput => ({
  topology: 'failover',
  candidates: [{ service: 'shop_db-replica', running: 1, replayLsn: '0/5000060', lagSeconds: 1 }],
  watermark: null,
  lastHealthyAt: null,
  confirmation: null,
  ...over,
});

describe('failover after the controller moved', () => {
  it('no history → holds for confirmation (an unknown window), never a silent promote', () => {
    const d = decideFailover(movedController());
    expect(d.kind).toBe('confirm');
    expect(d.kind === 'confirm' && d.target).toBe('shop_db-replica');
    expect(d.kind === 'confirm' && d.behindBytes).toBeNull();
  });

  it('an admin confirmation (read back from the label) promotes on the new controller', () => {
    const label = encodeFailoverConfirmation({ target: 'shop_db-replica', acceptBehindBytes: 'unknown', by: 'u1', at: '2026-09-25T15:00:00Z' });
    const d = decideFailover(movedController({ confirmation: parseFailoverConfirmation(label) }));
    expect(d).toMatchObject({ kind: 'promote', target: 'shop_db-replica', confirmed: true });
  });

  it('no running replica (it died with the node too) → waits, keeps counting', () => {
    expect(decideFailover(movedController({ candidates: [{ service: 'r', running: 0, replayLsn: null, lagSeconds: null }] })).kind).toBe('wait');
  });
});
