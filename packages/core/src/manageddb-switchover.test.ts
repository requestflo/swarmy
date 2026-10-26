import { describe, expect, it } from 'bun:test';
import { SWITCHOVER_CATCH_UP_BYTES, planSwitchover, type SwitchoverPlanInput } from './manageddb-switchover';

const P = 'shop_db-primary';
const R = 'shop_db-replica';
const EU = 'shop_db-replica-eu';

function input(over: Partial<SwitchoverPlanInput> = {}): SwitchoverPlanInput {
  return {
    cluster: 'db',
    topology: 'primary-replica',
    members: [
      { service: P, role: 'primary', desired: 1, running: 1 },
      { service: R, role: 'replica', desired: 1, running: 1 },
      { service: EU, role: 'replica', desired: 1, running: 1 },
    ],
    standbys: [
      { service: R, nodeId: 'n2', state: 'streaming', lagBytes: 4096 },
      { service: EU, nodeId: 'n3', state: 'streaming', lagBytes: 120 },
    ],
    directApps: [],
    copyName: (s) => (s === R ? "wkr-2's copy" : s === EU ? "eu-1's copy" : s),
    ...over,
  };
}

const code = (i: SwitchoverPlanInput) => {
  const p = planSwitchover(i);
  return p.ok ? 'ok' : p.code;
};

describe('planSwitchover — who may take the writes', () => {
  it('picks the most caught-up streaming copy when none is named', () => {
    expect(planSwitchover(input())).toEqual({ ok: true, from: P, target: EU, nodeId: 'n3', behindBytes: 120, restarts: [] });
  });

  it('takes a named copy that is streaming and within one WAL segment', () => {
    expect(planSwitchover(input({ target: R }))).toEqual({ ok: true, from: P, target: R, nodeId: 'n2', behindBytes: 4096, restarts: [] });
  });

  it('ties go to the service name, so the pick is deterministic', () => {
    const tie = input({ standbys: [{ service: R, nodeId: 'n2', state: 'streaming', lagBytes: 0 }, { service: EU, nodeId: 'n3', state: 'streaming', lagBytes: 0 }] });
    expect(planSwitchover(tie)).toMatchObject({ ok: true, target: R });
  });

  it('skips an ineligible copy for the next best one', () => {
    const p = planSwitchover(input({ standbys: [{ service: R, nodeId: 'n2', state: 'streaming', lagBytes: 10 }, { service: EU, nodeId: 'n3', state: 'catchup', lagBytes: 0 }] }));
    expect(p).toMatchObject({ ok: true, target: R });
  });
});

describe('planSwitchover — every refusal', () => {
  it('active-active: every copy already writes', () => {
    expect(code(input({ topology: 'active-active' }))).toBe('not-supported');
  });

  it('no running writer: that is the failover rule, not a planned switch', () => {
    expect(code(input({ members: input().members.map((m) => (m.role === 'primary' ? { ...m, running: 0 } : m)) }))).toBe('no-writer');
    expect(code(input({ members: input().members.filter((m) => m.role !== 'primary') }))).toBe('no-writer');
  });

  it('busy: a held failover, a switchover or a planned restart in flight', () => {
    const p = planSwitchover(input({ busy: 'A switch-over is already running.' }));
    expect(p).toEqual({ ok: false, code: 'busy', reason: 'A switch-over is already running.' });
  });

  it('an app wired straight to the writer is no refusal: it follows, and the plan names it to restart', () => {
    const p = planSwitchover(input({ target: R, directApps: ['shop_worker', 'shop_api'] }));
    expect(p).toEqual({ ok: true, from: P, target: R, nodeId: 'n2', behindBytes: 4096, restarts: ['shop_api', 'shop_worker'] });
  });

  it('single, or no standby declared', () => {
    expect(code(input({ topology: 'single' }))).toBe('no-standby');
    expect(code(input({ members: [input().members[0]!] }))).toBe('no-standby');
  });

  it('the writer itself, or a service that is not a standby copy', () => {
    expect(code(input({ target: P }))).toBe('target-is-writer');
    expect(code(input({ target: 'shop_web' }))).toBe('unknown-target');
  });

  it('a copy sharing its service with another copy cannot be promoted alone', () => {
    const shared = input({ target: R, members: input().members.map((m) => (m.service === R ? { ...m, desired: 2, running: 2 } : m)) });
    const p = planSwitchover(shared);
    expect(p).toMatchObject({ ok: false, code: 'shared-copy', target: R });
    if (!p.ok) expect(p.reason).toBe('shop_db-replica runs 2 standby copies as one service, so no one of them can take the writes on its own. Keep one standby copy per service first.');
  });

  it('a copy that is not streaming (or has no row at all)', () => {
    const p = planSwitchover(input({ target: R, standbys: [{ service: R, nodeId: 'n2', state: 'catchup', lagBytes: 0 }] }));
    expect(p).toMatchObject({ ok: false, code: 'not-streaming', target: R });
    if (!p.ok) expect(p.reason).toBe("wkr-2's copy is catchup, not streaming, so it can't take the writes yet.");
    expect(code(input({ target: R, standbys: [] }))).toBe('not-streaming');
  });

  it('a copy further behind than one WAL segment, or not measured', () => {
    const far = input({ target: R, standbys: [{ service: R, nodeId: 'n2', state: 'streaming', lagBytes: SWITCHOVER_CATCH_UP_BYTES + 1 }] });
    const p = planSwitchover(far);
    expect(p).toMatchObject({ ok: false, code: 'behind' });
    if (!p.ok) expect(p.reason).toBe("wkr-2's copy is 16 MB behind. Wait until it catches up.");
    expect(code(input({ target: R, standbys: [{ service: R, nodeId: 'n2', state: 'streaming', lagBytes: null }] }))).toBe('behind');
    const edge = input({ target: R, standbys: [{ service: R, nodeId: 'n2', state: 'streaming', lagBytes: SWITCHOVER_CATCH_UP_BYTES }] });
    expect(code(edge)).toBe('ok');
  });

  it('with nobody eligible, says why about the most caught-up copy', () => {
    const p = planSwitchover(input({ standbys: [{ service: R, nodeId: 'n2', state: 'streaming', lagBytes: 64 << 20 }, { service: EU, nodeId: 'n3', state: 'streaming', lagBytes: 32 << 20 }] }));
    expect(p).toMatchObject({ ok: false, code: 'behind', target: EU });
  });
});
