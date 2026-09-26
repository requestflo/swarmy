import type { DeployStep, StepKey } from './deploy-steps';

type Times = Partial<Record<StepKey, number>>;

/**
 * Pure: how long each finished step took (board "Deploying": 0:12, 0:09…),
 * not when it finished. A streamed step knows when it started; a polled one
 * is timed from the end of the step before it (or the deploy's start).
 */
export function stepDurations(steps: readonly DeployStep[], doneAt: Times, startedAt: Times): Times {
  const out: Times = {};
  let prevDone = 0;
  for (const s of steps) {
    const done = doneAt[s.key];
    if (done === undefined) continue;
    const from = startedAt[s.key] ?? Math.min(prevDone, done);
    out[s.key] = Math.max(0, done - from);
    prevDone = Math.max(prevDone, done);
  }
  return out;
}
