/**
 * Workflow runner worker (spine stub — owned by slice B3 workflow-engine).
 *
 * Will advance `WorkflowRun` state machines each tick: execute the next step
 * (container / service-exec / webhook / approval / delay) with per-step
 * timeout/retry and persist cursor + state. Inert until B3 fills in the tick
 * body.
 */

const TICK_MS = 30_000;

export function startWorkflowRunner(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice B3 (workflow-engine) implements the runner tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
