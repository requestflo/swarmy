import { describe, expect, it } from 'bun:test';
import { STEP_ORDER, driveRun, newRunState, type RunState, type StepHandlers, type StepKey } from './platform-upgrade.plan';
import { abandonPreview, abandonRun, beginAbandon, lastFinishedStep, pauseRequested, resumeRun, withPauseRequest } from './platform-upgrade.pause';
import { sameImage, systemAbandon } from './platform-upgrade.abandon';

const now = () => new Date('2026-10-24T10:00:00Z');

function handlers(calls: string[], over: Partial<Record<StepKey, Partial<StepHandlers[StepKey]>>> = {}): StepHandlers {
  return Object.fromEntries(
    STEP_ORDER.map((k) => [k, { run: async () => (calls.push(`run:${k}`), { status: 'done' as const }), ...over[k] }]),
  ) as StepHandlers;
}

/** Persist through JSON, like the DB row, so nothing in memory survives a "restart". */
function row(start: RunState = newRunState()) {
  let stored = JSON.stringify(start);
  return { load: (): RunState => JSON.parse(stored), save: async (r: RunState) => void (stored = JSON.stringify(r)) };
}

describe('pause after this step (the pure engine)', () => {
  it('finishes the current step, then halts paused on the next one; nothing after it runs', async () => {
    const calls: string[] = [];
    let asked = false;
    const h = handlers(calls, { controller: { run: async () => ((asked = true), calls.push('run:controller'), { status: 'done' }) } });
    const run = newRunState();
    expect(await driveRun(run, h, async () => undefined, now, { pauseRequested: () => asked })).toBe('paused');
    expect(run).toMatchObject({ status: 'paused', step: 'agents' });
    expect(calls).toEqual(['run:preflight', 'run:controller']);
    expect(lastFinishedStep(run)).toBe('controller');
    // A paused run is idle to the driver: the worker tick never moves it.
    expect(await driveRun(run, h, async () => undefined, now)).toBe('idle');
  });

  it('a waiting step is not finished: the request lands after it completes, in the NEW controller', async () => {
    const calls: string[] = [];
    let restarted = false;
    const h = handlers(calls, { controller: { run: async () => (restarted ? { status: 'done' } : { status: 'wait' }) } });
    const db = row();
    let options: object = { skipBackup: false };
    const asked = () => pauseRequested(JSON.parse(JSON.stringify(options)));
    expect(await driveRun(db.load(), h, db.save, now, { pauseRequested: asked })).toBe('waiting');
    // Asked while the old controller waits to be replaced; the row carries it across the restart.
    options = withPauseRequest(options, now().toISOString(), 'u1');
    restarted = true;
    expect(await driveRun(db.load(), h, db.save, now, { pauseRequested: asked })).toBe('paused');
    expect(db.load()).toMatchObject({ status: 'paused', step: 'agents' });
    expect(calls).toEqual(['run:preflight']);
  });

  it('a request on the last step is moot: the run just finishes', async () => {
    const run = newRunState();
    let n = 0;
    expect(await driveRun(run, handlers([]), async () => undefined, now, { pauseRequested: () => ++n === STEP_ORDER.length })).toBe('done');
  });

  it('resume carries on from the step it stopped before, never redoing finished ones', async () => {
    const calls: string[] = [];
    const run = newRunState();
    await driveRun(run, handlers(calls), async () => undefined, now, { pauseRequested: () => true });
    resumeRun(run, now);
    expect(run.status).toBe('running');
    expect(await driveRun(run, handlers(calls), async () => undefined, now)).toBe('done');
    expect(calls).toEqual(STEP_ORDER.map((k) => `run:${k}`));
    expect(() => resumeRun(run, now)).toThrow(/only a paused upgrade/);
    expect(pauseRequested(withPauseRequest({ skipBackup: true }, null))).toBe(false);
  });
});

describe('abandon a paused run', () => {
  async function pausedAfter(key: StepKey): Promise<RunState> {
    const run = newRunState();
    await driveRun(run, handlers([]), async () => undefined, now, { pauseRequested: () => run.steps.find((s) => s.key === key)?.status === 'done' });
    return run;
  }

  it('previews and puts back agents + system, newest first; controller and a Garage major stay', async () => {
    const run = await pausedAfter('engines');
    const p = abandonPreview(run);
    expect(p.putBack).toEqual(['system', 'agents']);
    expect(p.kept.map((k) => k.key)).toEqual(['engines', 'controller']);
    const order: string[] = [];
    const h = handlers([], {
      agents: { rollback: async () => void order.push('agents') },
      system: { abandon: async () => (order.push('system'), 'swarmy-dns back') },
    });
    expect(() => beginAbandon({ ...run, status: 'running' }, now)).toThrow(/only a paused upgrade/);
    beginAbandon(run, now);
    expect(await abandonRun(run, h, async () => undefined, now)).toBe('abandoned');
    expect(order).toEqual(['system', 'agents']);
    expect(run.steps.map((s) => `${s.key}:${s.status}`)).toEqual([
      'preflight:done', 'controller:done', 'agents:rolled-back', 'system:rolled-back', 'engines:done', 'verify:pending',
    ]);
    expect(run.log.some((l) => /kept: the controller stays on the new build/.test(l.msg))).toBe(true);
  });

  it('survives a restart mid-abandon: what was put back is not put back twice', async () => {
    const db = row(beginAbandon(await pausedAfter('system'), now));
    const order: string[] = [];
    // The old process dies inside the agents rollback (it never returns).
    const dying = handlers([], { system: { abandon: async () => void order.push('system') }, agents: { rollback: () => new Promise(() => undefined) } });
    void abandonRun(db.load(), dying, db.save, now);
    await Bun.sleep(5);
    expect(db.load()).toMatchObject({ status: 'abandoning', step: 'agents' });
    // The new process loads the row and carries on.
    const ok = handlers([], { system: { abandon: async () => void order.push('system') }, agents: { rollback: async () => void order.push('agents') } });
    expect(await abandonRun(db.load(), ok, db.save, now)).toBe('abandoned');
    expect(order).toEqual(['system', 'agents']);
  });

  it('something that cannot be put back leaves the run paused with the reason; Abandon again finishes it', async () => {
    const db = row(beginAbandon(await pausedAfter('system'), now));
    const order: string[] = [];
    const bad = handlers([], { system: { abandon: async () => void order.push('system') }, agents: { rollback: async () => Promise.reject(new Error('node-2 offline')) } });
    expect(await abandonRun(db.load(), bad, db.save, now)).toBe('paused');
    expect(db.load()).toMatchObject({ status: 'paused', error: 'Abandon stopped at Agents: node-2 offline' });
    expect(abandonPreview(db.load()).putBack).toEqual(['agents']);
    const ok = handlers([], { system: { abandon: async () => void order.push('system') }, agents: { rollback: async () => void order.push('agents') } });
    expect(await abandonRun(beginAbandon(db.load(), now), ok, db.save, now)).toBe('abandoned');
    expect(order).toEqual(['system', 'agents']);
  });
});

describe('systemAbandon (exact previous image, health-gated, idempotent)', () => {
  it('rolls each moved service back to its recorded image, skips one already back, and forgets both', async () => {
    const step = { key: 'system' as const, status: 'done' as const, data: { updated: ['swarmy-dns', 'swarmy-ingress-caddy'], from: { 'swarmy-dns': 'dns@sha256:' + 'a'.repeat(64), 'swarmy-ingress-caddy': 'caddy:2.8' } } };
    const updates: string[] = [];
    const r = await systemAbandon({ run: newRunState(), step, checkpoint: async () => undefined, note: () => undefined }, {
      live: () => [{ name: 'swarmy-dns', image: 'dns:1.3@sha256:' + 'a'.repeat(64) }, { name: 'swarmy-ingress-caddy', image: 'caddy:2.9' }],
      update: async (svc, image) => (updates.push(`${svc} ${image}`), { rc: 0, state: 'completed' }),
    });
    expect(updates).toEqual(['swarmy-ingress-caddy caddy:2.8']);
    expect(step.data.updated).toEqual([]);
    expect(r).toBe('swarmy-ingress-caddy, swarmy-dns back on the previous images');
    expect(sameImage('x@sha256:' + 'b'.repeat(64), 'y:1@sha256:' + 'b'.repeat(64))).toBe(true);
  });

  it('a service that will not come back healthy throws (the run stays paused) and stays listed', async () => {
    const step = { key: 'system' as const, status: 'done' as const, data: { updated: ['swarmy-dns'], from: { 'swarmy-dns': 'dns:1.2' } } };
    const io = { live: () => [{ name: 'swarmy-dns', image: 'dns:1.3' }], update: async () => ({ rc: 0, state: 'rollback_completed' }) };
    await expect(systemAbandon({ run: newRunState(), step, checkpoint: async () => undefined, note: () => undefined }, io)).rejects.toThrow(/swarmy-dns could not go back healthy/);
    expect(step.data.updated).toEqual(['swarmy-dns']);
  });
});
