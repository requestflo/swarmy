import { describe, expect, it } from 'bun:test';
import { decideFailover, type DecideFailoverInput } from './manageddb-failover';
import {
  DB_FAILOVER_PROMOTING_LABEL,
  chosenCopy,
  needsReshape,
  parseCopyProbe,
  planCopyPromotion,
  promotingMark,
  writerScaleRefusal,
  type StandbyCopy,
} from './manageddb-failover-copies';

/**
 * One promotion, one writer: failover decides and acts per COPY. A standby
 * service runs one copy per server, so a service-level candidate is refused
 * and every pass names exactly one copy (or holds).
 */

const R = 'shop_db-replica';
const MARK = '0/3000000';
const copy = (node: string | null, over: Partial<StandbyCopy> = {}): StandbyCopy => ({
  service: R,
  node,
  containerId: `c-${node}`,
  agent: `agent-${node}`,
  inRecovery: true,
  replayLsn: MARK,
  lagSeconds: 0,
  ...over,
});
const decide = (candidates: DecideFailoverInput['candidates'], over: Partial<DecideFailoverInput> = {}) =>
  decideFailover({ topology: 'failover', candidates, watermark: { lsn: MARK, sampledAt: 1 }, lastHealthyAt: 1, confirmation: null, ...over });

describe('decideFailover never promotes a service that stands for several copies', () => {
  it('a 2-copy service-level candidate is refused, not promoted', () => {
    const d = decide([{ service: R, running: 2, replayLsn: MARK, lagSeconds: 0 }]);
    expect(d.kind).toBe('refuse');
    expect(d.kind === 'refuse' && d.target).toBe(R);
  });

  it('per-copy candidates: the caught-up copy is named, never the one behind', () => {
    const plan = planCopyPromotion({ copies: [copy('x', { replayLsn: '0/2FFFFFF' }), copy('y')], promoting: null });
    expect(plan.kind).toBe('decide');
    const d = decide(plan.kind === 'decide' ? plan.candidates : []);
    expect(d).toEqual({ kind: 'promote', target: R, copy: 'y', behindBytes: 0, behindSeconds: 0, confirmed: false });
  });

  it('an admin confirmation of the service promotes its most caught-up copy, within the accepted window', () => {
    const plan = planCopyPromotion({ copies: [copy('x', { replayLsn: '0/2FFFF00' }), copy('y', { replayLsn: '0/2FFFFF0' })], promoting: null });
    const candidates = plan.kind === 'decide' ? plan.candidates : [];
    const d = decide(candidates, { confirmation: { target: R, acceptBehindBytes: 16 } });
    expect(d.kind === 'promote' && [d.copy, d.behindBytes, d.confirmed]).toEqual(['y', 16, true]);
  });
});

describe('planCopyPromotion: a pass may only ever make one writer', () => {
  it('two copies already out of recovery: refuse', () => {
    const plan = planCopyPromotion({ copies: [copy('x', { inRecovery: false }), copy('y', { inRecovery: false })], promoting: null });
    expect(plan.kind).toBe('refuse');
  });

  it('a copy writing that swarmy did not promote: refuse', () => {
    expect(planCopyPromotion({ copies: [copy('x', { inRecovery: false }), copy('y')], promoting: null }).kind).toBe('refuse');
  });

  it('mid-promotion: resume the stamped copy even when another looks better', () => {
    const plan = planCopyPromotion({ copies: [copy('x', { inRecovery: null, replayLsn: null }), copy('y')], promoting: { service: R, node: 'x' } });
    expect(plan.kind === 'resume' && plan.copy.node).toBe('x');
    const done = planCopyPromotion({ copies: [copy('x', { inRecovery: false }), copy('y')], promoting: { service: R, node: 'x' } });
    expect(done.kind === 'resume' && done.copy.node).toBe('x');
  });

  it('mid-promotion, the stamped copy unreachable or another copy writing: refuse', () => {
    expect(planCopyPromotion({ copies: [copy('y')], promoting: { service: R, node: 'x' } }).kind).toBe('refuse');
    const other = planCopyPromotion({ copies: [copy('x'), copy('y', { inRecovery: false })], promoting: { service: R, node: 'x' } });
    expect(other.kind).toBe('refuse');
  });

  it('a copy that did not answer is a candidate with no proof (only an admin can accept it); one on an unknown server is not', () => {
    const plan = planCopyPromotion({ copies: [copy('x', { inRecovery: null }), copy(null)], promoting: null });
    expect(plan.kind === 'decide' && plan.candidates).toEqual([{ service: R, copy: 'x', running: 1, replayLsn: null, lagSeconds: 0 }]);
    expect(planCopyPromotion({ copies: [copy(null)], promoting: null }).kind).toBe('refuse');
  });

  it('the mark, the reshape test, the probe parser and the chosen copy', () => {
    expect(promotingMark([{ name: 'a', labels: {} }, { name: R, labels: { [DB_FAILOVER_PROMOTING_LABEL]: 'x' } }])).toEqual({ service: R, node: 'x' });
    expect(promotingMark([{ name: R, labels: {} }])).toBeNull();
    expect(needsReshape({ desiredReplicas: 2, runningReplicas: 2 })).toBe(true);
    expect(needsReshape({ desiredReplicas: 1, runningReplicas: 2 })).toBe(true);
    expect(needsReshape({ desiredReplicas: 1, runningReplicas: 1 })).toBe(false);
    expect(parseCopyProbe('true|1.234|0/3000000\n')).toEqual({ inRecovery: true, lagSeconds: 1.2, replayLsn: MARK });
    expect(parseCopyProbe('false|0|')).toEqual({ inRecovery: false, lagSeconds: 0, replayLsn: null });
    expect(parseCopyProbe('ERROR: nope')).toBeNull();
    expect(chosenCopy([copy('x'), copy('y')], { target: R, copy: 'y' })?.containerId).toBe('c-y');
    expect(chosenCopy([copy('x')], { target: R })).toBeUndefined();
  });

  it('a plain scale of the writer past one copy is refused; standbys and other services are not', () => {
    const writer = { 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary' };
    expect(writerScaleRefusal(writer, 2)).toContain('runs as one copy');
    expect(writerScaleRefusal(writer, 1)).toBeNull();
    expect(writerScaleRefusal({ ...writer, 'swarmy.db.role': 'replica' }, 3)).toBeNull();
    expect(writerScaleRefusal({}, 3)).toBeNull();
  });
});
