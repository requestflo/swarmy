/**
 * Alert evaluator worker (spine stub — owned by slice C3 alerts).
 *
 * Will evaluate alert-rule signals each tick (hub inventory, node stats,
 * manageddb labels, backup results, ClickHouse RED metrics, cert expiry) →
 * fire/resolve `AlertEvent`s, notify channels, write `UptimeSample`s per
 * status-page component, and auto-open/resolve `Incident`s. Inert until C3
 * fills in the tick body.
 */

const TICK_MS = 30_000;

export function startAlertEvaluator(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice C3 (alerts) implements the evaluator tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
