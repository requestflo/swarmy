import { describe, expect, it } from 'bun:test';
import { SWITCHOVER_BUSY, newSwitchoverRun, withSwitchoverStep } from '@swarmy/core';
import { copyNameOf, planCopy, type PgSwitchoverFacts } from './pg-switchover-plan';
import { runWords } from './pg-switchover-words';

const P = 'storefront_checkout-primary';
const R = 'storefront_checkout-replica';
const names: Record<string, string> = { [P]: "wkr-1's copy", [R]: "mgr-2's copy" };

function facts(over: Partial<PgSwitchoverFacts> = {}): PgSwitchoverFacts {
  return {
    cluster: {
      name: 'checkout',
      topology: 'primary-replica',
      members: [
        { service: P, role: 'primary', desired: 1, running: 1 },
        { service: R, role: 'replica', desired: 1, running: 1 },
      ],
    },
    standbys: [{ service: R, nodeId: 'n-mgr-2', state: 'streaming', lagBytes: 232 }],
    apps: [{ service: 'storefront_api', via: 'pooler' }],
    running: false,
    copyName: (s) => names[s] ?? s,
    ...over,
  };
}

describe('planCopy — the dashboard asks the shared plan, on the same reads', () => {
  it('nothing until both reads are in (never a guess)', () => {
    expect(planCopy(facts({ standbys: null }), R)).toBeNull();
    expect(planCopy(facts({ apps: null }), R)).toBeNull();
  });

  it('a caught-up copy with every app through the pooler can take the writes', () => {
    expect(planCopy(facts(), R)).toEqual({ ok: true, from: P, target: R, nodeId: 'n-mgr-2', behindBytes: 232 });
  });

  it('an app straight to the main copy, a held failover, a run in flight', () => {
    expect(planCopy(facts({ apps: [{ service: 'storefront_checkout', via: 'direct' }] }), R)).toMatchObject({ ok: false, code: 'direct-apps' });
    const held = facts();
    held.cluster = { ...held.cluster, pendingFailover: { target: R } };
    expect(planCopy(held, R)).toEqual({ ok: false, code: 'busy', reason: SWITCHOVER_BUSY.held });
    expect(planCopy(facts({ running: true }), R)).toEqual({ ok: false, code: 'busy', reason: SWITCHOVER_BUSY.running });
  });

  it('names the copy by its server', () => {
    const p = planCopy(facts({ standbys: [{ service: R, nodeId: 'n-mgr-2', state: 'streaming', lagBytes: 40 << 20 }] }), R);
    expect(p).toMatchObject({ ok: false, code: 'behind', reason: "mgr-2's copy is 40 MB behind. Wait until it catches up." });
  });

  it('copyNameOf: the first server, else the short name', () => {
    expect(copyNameOf(R, [{ name: 'mgr-2' }], (s) => s.slice(11))).toBe("mgr-2's copy");
    expect(copyNameOf(R, undefined, (s) => s.slice(11))).toBe('checkout-replica');
    expect(copyNameOf(R, [{ name: 'mgr-1' }, { name: 'wkr-1' }], (s) => s)).toBe("mgr-1 and wkr-1's copies");
  });
});

describe('runWords — the progress card', () => {
  const run = newSwitchoverRun({ runId: 'sw1', stack: 'storefront', cluster: 'checkout', from: P, target: R, targetNodeId: 'n-mgr-2', startedAt: 'T0' });
  const name = (s: string) => names[s] ?? s;

  it('running: what it is doing now', () => {
    expect(runWords(withSwitchoverStep(run, 'catch-up', 'running'), name)).toEqual({ tone: 'info', lead: "Making mgr-2's copy the writer.", rest: 'Now: let the copy catch up.' });
  });

  it('done: how long writes paused, and that nothing was lost', () => {
    const done = { ...withSwitchoverStep(run, 'rejoin', 'done'), pausedSeconds: 4 };
    expect(runWords(done, name)).toEqual({ tone: 'ok', lead: "mgr-2's copy is the writer.", rest: 'Writes paused for 4 s; nothing was lost.' });
    const settling = withSwitchoverStep(run, 'rejoin', 'warn');
    expect(runWords(settling, name).rest).toBe("Writes paused for a few seconds; nothing was lost. wkr-1's copy is still catching up as a standby.");
  });

  it('aborted: the reason as a sentence, and who kept the writes', () => {
    const v = withSwitchoverStep(run, 'catch-up', 'failed', 'the copy was still 256 bytes behind the paused main copy, so nothing was switched and writes resumed');
    expect(runWords(v, name)).toEqual({
      tone: 'warn',
      lead: 'Nothing was switched.',
      rest: "The copy was still 256 bytes behind the paused main copy, so nothing was switched and writes resumed. wkr-1's copy kept the writes.",
    });
  });
});
