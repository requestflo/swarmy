import type { StatusTone } from '@swarmy/ui';

/** Mirrors the controller's `EdgeRuntimeStatus['state']` (ingress-controller.ts). */
export type EdgeState =
  | 'tracking'
  | 'paused'
  | 'unverified'
  | 'down'
  | 'deploying'
  | 'degraded'
  | 'serving';

/**
 * Badge tone for the edge's RUNTIME state — green only when a swarmy-run proxy
 * is actually up and carrying the current config, never from saved config.
 */
export function edgeTone(state: EdgeState | undefined): StatusTone {
  switch (state) {
    case 'serving':
      return 'online';
    case 'deploying':
      return 'progress';
    case 'degraded':
    case 'unverified':
      return 'warning';
    case 'down':
      return 'offline';
    default:
      return 'neutral';
  }
}

const STATE_LABEL: Record<EdgeState, string> = {
  tracking: 'Tracking only',
  paused: 'Paused',
  unverified: 'unverified',
  down: 'down',
  deploying: 'starting',
  degraded: 'degraded',
  serving: 'serving',
};

/** "Caddy · serving", "Caddy · down", "Tracking only", … */
export function edgeLabel(driverLabel: string, state: EdgeState | undefined): string {
  if (!state) return driverLabel;
  if (state === 'tracking' || state === 'paused') return STATE_LABEL[state];
  return `${driverLabel} · ${STATE_LABEL[state]}`;
}

/** Short per-route label when a route is configured but NOT being served. */
export function notServingLabel(state: EdgeState | undefined): string {
  switch (state) {
    case 'tracking':
      return 'not routed';
    case 'paused':
      return 'ingress paused';
    case 'deploying':
      return 'edge starting';
    case 'unverified':
      return 'unverified';
    case 'degraded':
      return 'edge degraded';
    default:
      return 'edge down';
  }
}
