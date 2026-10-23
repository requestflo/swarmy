/**
 * How long an upgrade (and each of its steps) took, from the run's own
 * timestamps. Pure, so the timeline, the summary and their tests agree.
 */

interface Timed {
  startedAt: string | null;
  finishedAt: string | null;
}

const at = (iso: string | null): number => (iso ? Date.parse(iso) : NaN);

/** "4 s" · "1 min 04 s" · "1 h 02 min". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * A step's (or run's) duration: finished → how long it took; started and still
 * going → how long so far (`live`). Null when it never started or the clock
 * reads backwards.
 */
export function durationOf(t: Timed, now = Date.now()): { ms: number; live: boolean } | null {
  const start = at(t.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = at(t.finishedAt);
  const live = !Number.isFinite(end);
  const ms = (live ? now : end) - start;
  return ms >= 0 ? { ms, live } : null;
}

/** "took 38 s" / "38 s so far" / '' — the timeline's per-step line. */
export function stepTimeWords(t: Timed, now = Date.now()): string {
  const d = durationOf(t, now);
  if (!d) return '';
  return d.live ? `${fmtDuration(d.ms)} so far` : `took ${fmtDuration(d.ms)}`;
}

/** The finished steps with how long each took, in run order (skipped steps left out). */
export function stepDurations<S extends Timed & { key: string; status: string }>(steps: readonly S[]): Array<{ key: string; ms: number }> {
  return steps.flatMap((s) => {
    const d = s.status === 'done' ? durationOf(s) : null;
    return d && !d.live ? [{ key: s.key, ms: d.ms }] : [];
  });
}
