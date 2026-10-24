/**
 * "Pause after this step" — Resume / Abandon for a platform upgrade run
 * (plans/epic-platform-upgrades.md §2). Pure: the IO is in
 * `platform-upgrade-control.service.ts`.
 *
 *   running ──pause asked──▶ (current step finishes) ──▶ paused
 *   paused ──Resume──▶ running        (carries on with the next step)
 *   paused ──Abandon──▶ abandoning ──▶ abandoned
 *                         └─ something couldn't be put back ─▶ paused (+ error)
 *
 * The request lives on the run row (`options.pauseRequestedAt`) and the driver
 * reads it fresh after every step, so it holds across the controller
 * replacing itself. Abandon walks the FINISHED steps newest-first and puts
 * back each one that can be put back (agents, system services — health-gated,
 * one at a time); the controller (its database moved forward: the preflight
 * backup is the way back) and a Garage major (data migrated forward) stay.
 * `abandoning` is re-driven by the worker tick, so a restart resumes it.
 */
import { STEP_LABEL, STEP_ORDER, noteOn, type RunState, type RunStatus, type StepContext, type StepHandlers, type StepKey } from './platform-upgrade.plan';

/** A run in one of these blocks starting another (and auto-apply). */
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['running', 'paused', 'abandoning'];
/** What the worker tick re-drives; `paused` waits for a person. */
export const DRIVEN_RUN_STATUSES: RunStatus[] = ['running', 'abandoning'];
/** Statuses with a `finishedAt`. */
export const FINISHED_RUN_STATUSES: RunStatus[] = ['done', 'failed', 'cancelled', 'abandoned'];

/** Steps Abandon puts back (their handlers carry `abandon` / `rollback`). */
export const REVERSIBLE_STEPS: readonly StepKey[] = ['agents', 'system'];

/** Why a finished step stays as it is on Abandon. */
export const KEPT_ON_ABANDON: Partial<Record<StepKey, string>> = {
  controller: 'the controller stays on the new build: its database already moved forward (the preflight backup is the way back)',
  engines: 'object storage stays on the new version: a Garage major moves its data forward, and a minor update is not rolled through every member again',
};

export interface PauseRequest {
  pauseRequestedAt?: string | null;
  pauseRequestedBy?: string | null;
}

/** Is a pause asked for on this run's options? Pure. */
export function pauseRequested(options: unknown): boolean {
  const o = options as PauseRequest | null | undefined;
  return typeof o?.pauseRequestedAt === 'string' && o.pauseRequestedAt.length > 0;
}

/** Options with the pause request set (`by` = who) or cleared (`at` null). Pure. */
export function withPauseRequest<T extends object>(options: T | null | undefined, at: string | null, by: string | null = null): T & PauseRequest {
  return { ...((options ?? {}) as T), pauseRequestedAt: at, pauseRequestedBy: at ? by : null };
}

/** The newest finished (done / skipped) step — what a paused run stopped after. */
export function lastFinishedStep(run: Pick<RunState, 'steps'>): StepKey | null {
  for (const key of [...STEP_ORDER].reverse()) {
    const s = run.steps.find((x) => x.key === key);
    if (s && (s.status === 'done' || s.status === 'skipped')) return key;
  }
  return null;
}

export interface AbandonPreview {
  /** Finished steps Abandon puts back, in the order it does them. */
  putBack: StepKey[];
  /** Finished steps that stay, with why. */
  kept: Array<{ key: StepKey; why: string }>;
}

/** What Abandon will do to this run, before anyone presses it. Pure. */
export function abandonPreview(run: Pick<RunState, 'steps'>, reversible: readonly StepKey[] = REVERSIBLE_STEPS): AbandonPreview {
  const out: AbandonPreview = { putBack: [], kept: [] };
  for (const key of [...STEP_ORDER].reverse()) {
    if (run.steps.find((x) => x.key === key)?.status !== 'done') continue;
    if (reversible.includes(key)) out.putBack.push(key);
    else if (KEPT_ON_ABANDON[key]) out.kept.push({ key, why: KEPT_ON_ABANDON[key]! });
  }
  return out;
}

function mustBePaused(run: RunState, verb: string): void {
  if (run.status !== 'paused') throw new Error(`only a paused upgrade can be ${verb} (this one is ${run.status})`);
}

/** Paused → running, from the step it stopped before. Throws when not paused. */
export function resumeRun(run: RunState, now: () => Date = () => new Date()): RunState {
  mustBePaused(run, 'resumed');
  run.status = 'running';
  run.error = null;
  noteOn(run, `resumed — carrying on with ${STEP_LABEL[run.step]}`, now);
  return run;
}

/** Paused → abandoning. Throws when not paused. */
export function beginAbandon(run: RunState, now: () => Date = () => new Date()): RunState {
  mustBePaused(run, 'abandoned');
  const p = abandonPreview(run);
  run.status = 'abandoning';
  run.error = null;
  noteOn(run, p.putBack.length ? `abandoning — putting back ${p.putBack.map((k) => STEP_LABEL[k]).join(', ')}` : 'abandoning — nothing to put back', now);
  return run;
}

/**
 * Put back every finished, reversible step, newest first, checkpointing after
 * each (idempotent across restarts: a step already `rolled-back` is skipped,
 * the one in progress is re-entered — its `abandon` must tolerate that).
 */
export async function abandonRun(
  run: RunState,
  handlers: StepHandlers,
  persist: (run: RunState) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<'abandoned' | 'paused' | 'idle'> {
  if (run.status !== 'abandoning') return 'idle';
  const note = (msg: string) => noteOn(run, msg, now);
  const checkpoint = () => persist(run);
  for (const key of [...STEP_ORDER].reverse()) {
    const step = run.steps.find((x) => x.key === key);
    const undo = handlers[key].abandon ?? handlers[key].rollback;
    if (step?.status !== 'done' || !undo) continue;
    run.step = key;
    await checkpoint();
    const c: StepContext = { run, step, checkpoint, note };
    try {
      const r = await undo(c, 'abandoned by an operator');
      step.status = 'rolled-back';
      step.finishedAt = now().toISOString();
      note(`${STEP_LABEL[key]} put back${r ? `: ${r}` : ''}`);
      await checkpoint();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      run.status = 'paused';
      run.error = `Abandon stopped at ${STEP_LABEL[key]}: ${reason}`;
      note(`${STEP_LABEL[key]} could not be put back: ${reason} — still paused; Abandon again or Resume`);
      await checkpoint();
      return 'paused';
    }
  }
  const kept = STEP_ORDER.filter((key) => run.steps.find((x) => x.key === key)?.status === 'done' && KEPT_ON_ABANDON[key]);
  for (const key of kept) note(`kept: ${KEPT_ON_ABANDON[key]}`);
  run.status = 'abandoned';
  run.error = null;
  note(kept.length ? 'abandoned — everything else is back on the previous release' : 'abandoned — the cluster is back on the previous release');
  await checkpoint();
  return 'abandoned';
}
