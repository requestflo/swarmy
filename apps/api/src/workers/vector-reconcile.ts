/**
 * Vector-store reconcile worker (spine stub — owned by slice F5 ai).
 *
 * Will mirror `manageddb-reconcile` for qdrant (+ pgvector-on-managed-PG): read
 * `swarmy.vector.*` labels from the live inventory each tick and converge the
 * vector services. Inert until F5 fills in the tick body.
 */

const TICK_MS = 30_000;

export function startVectorReconcile(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice F5 (ai) implements the reconcile tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
