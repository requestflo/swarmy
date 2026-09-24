/**
 * Issue lifecycle + alert decisions (pure).
 *
 *  - a fingerprint never seen before → NEW issue (alert `error-new-issue`);
 *  - an event for a `resolved` issue after it was resolved → REGRESSION
 *    (issue reopens, alert `error-regression`);
 *  - `resolved_next_release`: events from the release it was resolved in (or
 *    with no release) are expected stragglers; an event from any OTHER
 *    release means the fix didn't ship → regression;
 *  - `ignored` swallows everything (no reopen, no alert);
 *  - a SPIKE is decided by the worker from windowed counts ({@link isSpike}).
 */
import type { IssueStateRow, IssueStatus } from './query';

export type Transition =
  | { kind: 'new' }
  | { kind: 'regression'; previous: IssueStatus }
  | { kind: 'none' };

export function decideTransition(
  state: Pick<IssueStateRow, 'status' | 'status_changed_at' | 'resolved_in_release'> | null,
  event: { release: string; timestamp: number },
): Transition {
  if (!state) return { kind: 'new' };
  if (state.status === 'resolved') {
    const resolvedAt = Date.parse(`${state.status_changed_at.replace(' ', 'T')}Z`);
    if (!Number.isFinite(resolvedAt) || event.timestamp > resolvedAt) return { kind: 'regression', previous: 'resolved' };
    return { kind: 'none' };
  }
  if (state.status === 'resolved_next_release') {
    if (event.release && event.release !== state.resolved_in_release) {
      return { kind: 'regression', previous: 'resolved_next_release' };
    }
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Spike detection defaults: last 10 min vs the previous 24 h. */
export const SPIKE_WINDOW_MINUTES = 10;
export const SPIKE_BASELINE_HOURS = 24;
/** Fewer events than this in the window is never a spike (quiet issues stay quiet). */
export const SPIKE_MIN_EVENTS = 20;
/** The window must exceed the baseline rate by this factor. */
export const SPIKE_FACTOR = 5;

/**
 * Is `recent` (events in the last window) a spike against `baseline` (events
 * in the preceding `baselineHours`, window excluded)? The baseline rate is
 * scaled to one window; a brand-new issue has baseline 0 and spikes as soon
 * as it clears {@link SPIKE_MIN_EVENTS}.
 */
export function isSpike(
  recent: number,
  baseline: number,
  opts: { windowMinutes?: number; baselineHours?: number; minEvents?: number; factor?: number } = {},
): boolean {
  const w = opts.windowMinutes ?? SPIKE_WINDOW_MINUTES;
  const b = opts.baselineHours ?? SPIKE_BASELINE_HOURS;
  const min = opts.minEvents ?? SPIKE_MIN_EVENTS;
  const factor = opts.factor ?? SPIKE_FACTOR;
  if (recent < min) return false;
  const expectedPerWindow = baseline / ((b * 60) / w);
  return recent >= factor * Math.max(expectedPerWindow, 1);
}

/** Alert `resource` for an issue — the fireEvent dedupe axis (one open alert per issue). */
export function issueResource(stack: string, fingerprint: string): string {
  return `errors:${stack}:${fingerprint.slice(0, 12)}`;
}
