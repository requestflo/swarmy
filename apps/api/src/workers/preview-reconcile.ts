/**
 * Preview-environment reconcile worker (spine stub — owned by slice D4 previews).
 *
 * Will scan the live inventory each tick for `swarmy.preview.*` stack labels
 * and tear down preview stacks whose PR closed or whose TTL (`ttlHours`)
 * expired. Inert until D4 fills in the tick body.
 */

const TICK_MS = 60_000;

export function startPreviewReconcile(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice D4 (previews) implements the reconcile tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
