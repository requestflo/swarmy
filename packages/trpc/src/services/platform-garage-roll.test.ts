import { describe, expect, it } from 'bun:test';
import { HEALTH_GRACE_MS, garageRollTick, planGarageRoll, type GarageRollData } from './platform-garage-roll';
import { rollGarage, type GarageRollIO } from './platform-garage-roll.run';
import { newRunState, serviceUpdateScript, type StepContext } from './platform-upgrade.plan';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const target = { ref: 'dxflrs/garage:v2.5.0', image: 'docker.io/dxflrs/garage', digest: D('5') };
const healthy = { status: 'healthy', connected: 3 };

describe('planGarageRoll — inside one major only', () => {
  it('rolls a v2 store on another build; skips one on the release, one that is off, and a major in either direction', () => {
    expect(planGarageRoll({ image: `dxflrs/garage:v2.4.1@${D('4')}` }, target)).toEqual({ action: 'roll', from: `dxflrs/garage:v2.4.1@${D('4')}`, ref: target.ref, digest: D('5') });
    expect(planGarageRoll({ image: `dxflrs/garage:v2.5.0@${D('5')}` }, target).action).toBe('skip');
    expect(planGarageRoll(undefined, target)).toEqual({ action: 'skip', detail: 'object storage is off' });
    expect(planGarageRoll({ image: 'dxflrs/garage:v1.0.1' }, target)).toMatchObject({ action: 'skip', detail: expect.stringMatching(/engine migration/) });
    expect(planGarageRoll({ image: 'dxflrs/garage:v3.0.0' }, target)).toMatchObject({ action: 'skip', detail: expect.stringMatching(/never downgraded/) });
    expect(planGarageRoll({ image: 'dxflrs/garage:v2.4.1' }, { ...target, digest: undefined }).action).toBe('skip');
  });

  it('the update is one member at a time, stop-first, with a pause longer than the health grace', () => {
    const s = serviceUpdateScript('swarmy-garage', 'x', { detach: true, delay: '90s', order: 'stop-first' });
    expect(s).toContain('--update-parallelism 1 --update-delay 90s --update-order stop-first ');
    expect(s).toContain('--update-failure-action rollback');
    expect(HEALTH_GRACE_MS).toBeLessThan(90_000);
  });
});

describe('garageRollTick', () => {
  const d: GarageRollData = { from: 'a', to: `docker.io/dxflrs/garage@${D('5')}`, ref: target.ref, digest: D('5'), dispatchedAt: new Date(0).toISOString() };
  const obs = { updateState: 'updating', onTarget: 1, members: 3, health: healthy, now: 10_000 };
  it('waits while members move, and is done once all are on the build and the store is healthy', () => {
    expect(garageRollTick(d, obs).step).toEqual({ action: 'wait', detail: 'object storage: 1 of 3 member(s) on Garage v2.5.0' });
    expect(garageRollTick(d, { ...obs, onTarget: 3, updateState: 'completed' }).step.action).toBe('done');
    // All on target but Swarm still reports updating: not yet.
    expect(garageRollTick(d, { ...obs, onTarget: 3 }).step.action).toBe('wait');
  });

  it('a store that stays unhealthy past the grace is rolled back; a short blip is not', () => {
    const blip = garageRollTick(d, { ...obs, health: { status: 'degraded', connected: 2 } });
    expect(blip.step.action).toBe('wait');
    expect(blip.data.unhealthySince).toBe(10_000);
    expect(garageRollTick(blip.data, { ...obs, now: 10_000 + HEALTH_GRACE_MS }).data.unhealthySince).toBeUndefined();
    const stuck = garageRollTick(blip.data, { ...obs, health: null, now: 10_001 + HEALTH_GRACE_MS });
    expect(stuck.step).toEqual({ action: 'rollback', reason: 'object storage stayed unhealthy (not answering) for over a minute after a member restarted' });
  });

  it("Swarm's own rollback fails the step — but only once this update was seen rolling", () => {
    expect(garageRollTick(d, { ...obs, updateState: 'rollback_completed', onTarget: 0 }).step.action).toBe('wait');
    expect(garageRollTick({ ...d, seenRolling: true }, { ...obs, updateState: 'rollback_completed' }).step.action).toBe('fail');
  });

  it('gives up (and rolls back) when the roll never finishes', () => {
    expect(garageRollTick(d, { ...obs, now: 3 * 60_000 }, 60_000).step.action).toBe('rollback');
  });
});

describe('rollGarage — the engines step over fake IO', () => {
  function world(script: Array<{ state?: string; onTarget: number; health: typeof healthy | null }>, over: Partial<GarageRollIO> = {}) {
    const calls: string[] = [];
    let i = -1;
    const at = () => script[Math.max(0, Math.min(i, script.length - 1))]!;
    const io: GarageRollIO = {
      live: () => ({ image: `dxflrs/garage:v2.4.1@${D('4')}`, updateState: i < 0 ? 'completed' : at().state }),
      tasks: () => ({ running: 3, onTarget: i < 0 ? 0 : at().onTarget }),
      members: async () => 3,
      health: async () => (i < 0 ? healthy : at().health),
      resolve: async (t) => `${t.image}@${t.digest}`,
      update: async (to) => (calls.push(`update ${to}`), (i = 0), { rc: 0, state: 'updating', output: '' }),
      rollback: async () => (calls.push('rollback'), { rc: 0, state: 'rollback_completed' }),
      record: async (ref) => void calls.push(`record ${ref}`),
      sleep: async () => void i++,
      now: () => 1_000 + Math.max(0, i) * 30_000,
      ...over,
    };
    const run = newRunState();
    const step = run.steps.find((s) => s.key === 'engines')!;
    const c: StepContext = { run, step, checkpoint: async () => undefined, note: () => undefined };
    return { io, c, step, calls };
  }

  it('rolls, waits for each member and the store to be healthy, then records the version on the store', async () => {
    const w = world([
      { state: 'updating', onTarget: 1, health: { status: 'degraded', connected: 2 } },
      { state: 'updating', onTarget: 2, health: healthy },
      { state: 'completed', onTarget: 3, health: healthy },
    ]);
    expect(await rollGarage(w.c, target, w.io, 1)).toMatchObject({ status: 'done' });
    expect(w.calls).toEqual([`update docker.io/dxflrs/garage@${D('5')}`, 'record dxflrs/garage:v2.5.0']);
  });

  it('stops and puts every member back when the store stays unhealthy; a retry plans afresh', async () => {
    const w = world([{ state: 'updating', onTarget: 1, health: null }]);
    await expect(rollGarage(w.c, target, w.io, 1)).rejects.toThrow(/stayed unhealthy .*; every member was put back on the previous build/);
    expect(w.calls).toEqual([`update docker.io/dxflrs/garage@${D('5')}`, 'rollback']);
    expect(w.step.data?.garage).toBeUndefined();
  });

  it('never starts on an unhealthy store, and a resumed roll never dispatches twice', async () => {
    const sick = world([], { health: async () => ({ status: 'degraded', connected: 2 }) });
    await expect(rollGarage(sick.c, target, sick.io, 1)).rejects.toThrow(/not healthy \(degraded, 2\/3 connected\)/);
    expect(sick.calls).toEqual([]);
    const w = world([{ state: 'completed', onTarget: 3, health: healthy }]);
    w.step.data = { garage: { from: 'a', to: 'b', ref: target.ref, digest: D('5'), dispatchedAt: new Date(0).toISOString(), seenRolling: true } };
    w.io.update = async () => Promise.reject(new Error('dispatched twice'));
    await w.io.sleep(0);
    expect((await rollGarage(w.c, target, w.io, 1)).status).toBe('done');
  });
});
