import { MINUTE_MS, type TrafficCell } from '@swarmy/core';

/**
 * Idle decision for the scale-to-zero sleeper — pure, so the worker only ticks.
 *
 * Two activity signals: the activator's last request (a cold service's traffic
 * and the UI's Wake), and the edge's per-host request counts (the hub's
 * EdgeTrafficRing). Once a service is warm the edge routes straight to it and
 * the activator never sees another request, so without the edge signal a busy
 * service was slept one idle window after every wake.
 *
 * Edge counts are per host, not per path: a host shared by several services
 * keeps all of them awake. That errs towards awake, never towards sleeping a
 * service that is serving.
 */

/** The newest moment a request reached one of `hosts`, from 1-minute ring cells. */
export function lastEdgeRequestMs(cells: TrafficCell[], hosts: ReadonlySet<string>, now: number): number | undefined {
  let last: number | undefined;
  for (const c of cells) {
    if (c.requests <= 0 || !hosts.has(c.host)) continue;
    // A cell covers [t, t + 1 min); the request happened no later than its end.
    const at = Math.min(now, c.t + MINUTE_MS);
    if (last === undefined || at > last) last = at;
  }
  return last;
}

export type SleepDecision = 'sleep' | 'awake' | 'start-clock';

export function sleepDecision(input: {
  now: number;
  idleMs: number;
  /** Last activator request, if any since this controller started. */
  activatorAt: number | undefined;
  /** Last edge request to one of the service's hosts, if any in the window. */
  edgeAt: number | undefined;
}): SleepDecision {
  const last = Math.max(input.activatorAt ?? -Infinity, input.edgeAt ?? -Infinity);
  // First sight with no traffic seen anywhere: start the clock rather than sleep instantly.
  if (last === -Infinity) return 'start-clock';
  return input.now - last > input.idleMs ? 'sleep' : 'awake';
}
