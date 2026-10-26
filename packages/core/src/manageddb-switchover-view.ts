import { SWITCHOVER_PHASES, type SwitchoverPhase } from './manageddb-switchover-run';

/**
 * A planned switchover's live run as the progress card shows it
 * (`db.switchoverRun`): run state in the controller's memory, never a label
 * or a table — the record is its `db.switchover*` audit rows. PURE: the view
 * and the one reducer the relay, the runner and the demo all use.
 */

export type SwitchoverStepStatus = 'pending' | 'running' | 'done' | 'warn' | 'failed';

export interface DbSwitchoverStepView {
  phase: SwitchoverPhase;
  label: string;
  status: SwitchoverStepStatus;
  /** What happened, in plain words (null until the step says something). */
  message: string | null;
}

export interface DbSwitchoverRunView {
  runId: string;
  stack: string;
  cluster: string;
  /** The writer before (member service). */
  from: string;
  /** The copy taking the writes (member service) and the server it runs on. */
  target: string;
  targetNodeId: string | null;
  status: 'running' | 'done' | 'aborted';
  startedAt: string;
  finishedAt: string | null;
  /** Seconds writes were paused, once known. */
  pausedSeconds: number | null;
  steps: DbSwitchoverStepView[];
  /** Why it stopped (an abort), in plain words. */
  error: string | null;
}

export function newSwitchoverRun(i: {
  runId: string;
  stack: string;
  cluster: string;
  from: string;
  target: string;
  targetNodeId: string | null;
  startedAt: string;
}): DbSwitchoverRunView {
  return {
    ...i,
    status: 'running',
    finishedAt: null,
    pausedSeconds: null,
    steps: SWITCHOVER_PHASES.map((p) => ({ phase: p.phase, label: p.label, status: 'pending', message: null })),
    error: null,
  };
}

/** One step's new status and words; a failed step ends the run as aborted. */
export function withSwitchoverStep(
  v: DbSwitchoverRunView,
  phase: SwitchoverPhase,
  status: SwitchoverStepStatus,
  message: string | null = null,
  at: string = new Date().toISOString(),
): DbSwitchoverRunView {
  const steps = v.steps.map((s) => (s.phase === phase ? { ...s, status, message: message ?? s.message } : s));
  if (status === 'failed') return { ...v, steps, status: 'aborted', error: message, finishedAt: at };
  const last = steps[steps.length - 1]!;
  const over = last.phase === phase && (status === 'done' || status === 'warn');
  return { ...v, steps, ...(over ? { status: 'done' as const, finishedAt: at } : {}) };
}

/** The step running now, if any (the card's "Now: …"). */
export function currentSwitchoverStep(v: DbSwitchoverRunView): DbSwitchoverStepView | null {
  return v.steps.find((s) => s.status === 'running') ?? null;
}

/** End the run as aborted at the step it was on (an error thrown mid-step). */
export function abortSwitchoverRun(v: DbSwitchoverRunView, reason: string, at: string = new Date().toISOString()): DbSwitchoverRunView {
  if (v.status !== 'running') return v;
  const cur = currentSwitchoverStep(v) ?? v.steps.find((s) => s.status === 'pending');
  return cur ? withSwitchoverStep(v, cur.phase, 'failed', reason, at) : { ...v, status: 'aborted', error: reason, finishedAt: at };
}
