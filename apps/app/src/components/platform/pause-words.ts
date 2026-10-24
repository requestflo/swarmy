/**
 * Plain words for "Pause after this step" — a pausing, paused or abandoning
 * platform upgrade (design board: Upgrade.html). Pure, so the page and its
 * tests agree. Mirrors the run view in platform-upgrade.service.ts.
 */

export interface PauseRunLike {
  status: string;
  step: string;
  fromVersion: string;
  toVersion: string;
  error: string | null;
  steps: ReadonlyArray<{ key: string; status: string }>;
  abandon: { putBack: string[]; kept: Array<{ key: string; why: string }> } | null;
}

const PHRASE: Record<string, string> = {
  preflight: 'the checks',
  controller: 'the controller',
  agents: 'the agents',
  system: 'the system services',
  engines: 'object storage',
  verify: 'the final check',
};
const PLURAL = new Set(['preflight', 'agents', 'system']);

const phrase = (key: string): string => PHRASE[key] ?? key;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "a", "a and b", "a, b and c". */
export function listWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** The newest finished step (done / skipped), in run order. */
export function lastFinished(steps: PauseRunLike['steps']): string | null {
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped');
  return done.at(-1)?.key ?? null;
}

/** "Paused after the controller." */
export function pausedTitle(run: PauseRunLike): string {
  const last = lastFinished(run.steps);
  return last ? `Paused after ${phrase(last)}.` : 'Paused before anything changed.';
}

/** "The agents are next. Nothing else changes until you choose." */
export function pausedNext(run: PauseRunLike): string {
  const next = phrase(run.step);
  return `${cap(next)} ${PLURAL.has(run.step) ? 'are' : 'is'} next. Nothing else changes until you choose; apps keep serving on what has already moved.`;
}

/** "Pausing after the agents — it stops as soon as they finish." */
export function pausingWords(run: Pick<PauseRunLike, 'step'>): string {
  return `Pausing after ${phrase(run.step)}: it stops as soon as ${PLURAL.has(run.step) ? 'they finish' : 'that finishes'}.`;
}

/** What Abandon does, in one or two sentences. */
export function abandonWords(run: PauseRunLike): string {
  const p = run.abandon ?? { putBack: [], kept: [] };
  if (!p.putBack.length && !p.kept.length) return 'Abandon ends the upgrade here. Nothing has changed yet.';
  const back = p.putBack.length
    ? `Abandon puts ${listWords(p.putBack.map(phrase))} back on ${run.fromVersion}, one at a time, each health-checked.`
    : 'Abandon has nothing to put back.';
  if (!p.kept.length) return back;
  const kept = p.kept.map((k) => k.key);
  const one = kept.length === 1 && !PLURAL.has(kept[0]!);
  return `${back} ${cap(listWords(kept.map(phrase)))} ${one ? 'stays' : 'stay'} on ${run.toVersion}: ${one ? 'its' : 'their'} data already moved forward.`;
}
