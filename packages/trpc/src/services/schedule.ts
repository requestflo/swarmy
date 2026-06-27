/**
 * Pure backup-schedule helpers (epic: volumes-dr, P2 — scheduler).
 *
 * No IO. We support a small "cron-ish" interval model rather than full cron:
 * `every` N minutes/hours/days from an anchor. This is deterministic and easy
 * to golden-test; the scheduler worker reads `nextRunAt` and advances it.
 */

export type IntervalUnit = 'minutes' | 'hours' | 'days';

export interface ScheduleSpec {
  every: number;
  unit: IntervalUnit;
}

const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function intervalMs(spec: ScheduleSpec): number {
  if (spec.every <= 0) throw new Error('schedule interval must be positive');
  return spec.every * UNIT_MS[spec.unit];
}

/**
 * Compute the next run strictly after `from`, aligned to `anchor` + k*interval.
 * Catch-up safe: if many intervals were missed (worker was down), it returns the
 * first slot in the future rather than replaying every missed slot.
 */
export function nextRun(spec: ScheduleSpec, anchor: Date, from: Date): Date {
  const step = intervalMs(spec);
  const anchorMs = anchor.getTime();
  const fromMs = from.getTime();
  if (fromMs < anchorMs) return new Date(anchorMs);
  const elapsed = fromMs - anchorMs;
  const k = Math.floor(elapsed / step) + 1;
  return new Date(anchorMs + k * step);
}

/** Whether a job with this `nextRunAt` is due as of `now`. */
export function isDue(nextRunAt: Date | null, now: Date): boolean {
  return nextRunAt != null && nextRunAt.getTime() <= now.getTime();
}
