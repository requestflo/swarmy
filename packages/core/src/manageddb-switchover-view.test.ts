import { describe, expect, it } from 'bun:test';
import { abortSwitchoverRun, currentSwitchoverStep, newSwitchoverRun, withSwitchoverStep } from './manageddb-switchover-view';

const run = () =>
  newSwitchoverRun({ runId: 'sw1', stack: 'shop', cluster: 'db', from: 'shop_db-primary', target: 'shop_db-replica', targetNodeId: 'n2', startedAt: 'T0' });

describe('the switchover run view', () => {
  it('starts with every step pending, in order', () => {
    const v = run();
    expect(v.status).toBe('running');
    expect(v.steps.map((s) => `${s.phase}:${s.status}`)).toEqual(['pause:pending', 'catch-up:pending', 'promote:pending', 'repoint:pending', 'rejoin:pending']);
  });

  it('a step moves on; the last step done (or warn) ends the run', () => {
    let v = withSwitchoverStep(run(), 'pause', 'running', null, 'T1');
    expect(currentSwitchoverStep(v)?.phase).toBe('pause');
    v = withSwitchoverStep(v, 'pause', 'done', 'Writes paused.', 'T2');
    expect(v.steps[0]).toMatchObject({ status: 'done', message: 'Writes paused.' });
    expect(currentSwitchoverStep(v)).toBeNull();
    v = withSwitchoverStep(v, 'rejoin', 'warn', 'still copying', 'T9');
    expect([v.status, v.finishedAt]).toEqual(['done', 'T9']);
  });

  it('a failed step aborts the run with its reason', () => {
    const v = withSwitchoverStep(run(), 'catch-up', 'failed', 'still 256 bytes behind', 'T3');
    expect([v.status, v.error, v.finishedAt]).toEqual(['aborted', 'still 256 bytes behind', 'T3']);
  });

  it('abort marks the step it was on, or the next pending one, and leaves a finished run alone', () => {
    const on = abortSwitchoverRun(withSwitchoverStep(run(), 'pause', 'running'), 'exec refused', 'T4');
    expect(on.steps[0]).toMatchObject({ status: 'failed', message: 'exec refused' });
    const between = abortSwitchoverRun(withSwitchoverStep(run(), 'pause', 'done'), 'boom', 'T5');
    expect(between.steps[1]).toMatchObject({ status: 'failed' });
    const done = withSwitchoverStep(run(), 'rejoin', 'done');
    expect(abortSwitchoverRun(done, 'late')).toBe(done);
  });
});
