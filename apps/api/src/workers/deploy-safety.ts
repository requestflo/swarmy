/**
 * Deploy safety worker (spine stub — owned by slice D1 releases; D2 canary
 * plugs its watcher fn in via `deploy-canary.ts` once D1 creates the skeleton's
 * hook points).
 *
 * Will watch fresh `Release` rows each tick: health gates over
 * `healthGateJson.windowSec` via health-summary → mark healthy/failed,
 * auto-rollback when `swarmy.deploy.safety` enables it, and drive
 * canary/blue-green promotion or rollback. Inert until D1/D2 fill in the tick
 * body.
 */

const TICK_MS = 30_000;

export function startDeploySafety(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slices D1 (releases) + D2 (canary) implement the tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
