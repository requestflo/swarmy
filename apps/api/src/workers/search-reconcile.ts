/**
 * Managed-search reconcile worker (spine stub — owned by slice F4 managed-search).
 *
 * Will mirror `manageddb-reconcile` for meilisearch/typesense: read
 * `swarmy.search.*` labels from the live inventory each tick and converge the
 * single-node engines (volume, master-key secret, private-only networking).
 * Inert until F4 fills in the tick body.
 */

const TICK_MS = 30_000;

export function startSearchReconcile(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice F4 (managed-search) implements the reconcile tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
