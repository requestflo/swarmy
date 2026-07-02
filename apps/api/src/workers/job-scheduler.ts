/**
 * Scheduled-job worker (spine stub — owned by slice B2 jobs).
 *
 * Will evaluate `ScheduledJob` cron schedules each tick and fire due jobs —
 * kind `image` via `container.runOnce`, kind `service-exec` via `exec` — with
 * timeout/retries, `JobRun` rows, and `alertOnFailure` alert events. Inert
 * until B2 fills in the tick body.
 */

const TICK_MS = 30_000;

export function startJobScheduler(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice B2 (jobs) implements the scheduler tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
