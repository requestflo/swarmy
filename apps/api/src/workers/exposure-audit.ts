/**
 * Exposure audit worker (spine stub — owned by slice E3 exposure).
 *
 * Will scan the live inventory each tick against `ExposureConfig.rulesJson`
 * (published ports, ingress routes, managed-data flags) and stamp violations →
 * alert events for the Exposure page's violations feed. Inert until E3 fills
 * in the tick body.
 */

const TICK_MS = 60_000;

export function startExposureAudit(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice E3 (exposure) implements the audit tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
