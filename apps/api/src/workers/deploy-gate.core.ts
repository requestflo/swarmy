/**
 * Pure bits of the deploy safety gate (deploy-safety worker). No imports, so
 * `bun test` runs them without evaluating the @swarmy/trpc router graph.
 */

// Mirror of @swarmy/trpc releases.service.ts `decideGate` (the unit-tested
// canonical copy — a worker cannot subpath-import an internal trpc module).

export type GateDecision = 'wait' | 'healthy' | 'failed';

export function decideGate(input: {
  health: 'healthy' | 'degraded' | 'down' | 'unknown';
  elapsedSec: number;
  windowSec: number;
}): GateDecision {
  if (input.elapsedSec < input.windowSec) return 'wait';
  if (input.health === 'healthy') return 'healthy';
  if (input.health === 'degraded' || input.health === 'down') return 'failed';
  // unknown: grace period, then benefit of the doubt — a gate never wedges.
  return input.elapsedSec < input.windowSec * 2 ? 'wait' : 'healthy';
}

/** Loop guard: an automatic rollback release never auto-rolls back again. */
export function isAutoRollbackRelease(notes: string | null): boolean {
  return (notes ?? '').startsWith('Automatic rollback');
}

export interface GateFailure {
  /** Which watcher failed it: the health check, or the error trip. */
  by: 'health' | 'errors';
  /** Why, in plain words ("degraded; api restarting", "7% of requests failed, up from 0.4%"). */
  reasons: string;
}

/** The release's timeline line. */
export function failureNotes(f: GateFailure, putBack: boolean): string {
  if (f.by === 'health') return `Health gate failed: ${f.reasons}`;
  return `${putBack ? 'Stopped' : 'Failed'}: ${f.reasons}`;
}

/** The gate a release was recorded with (`Release.healthGateJson`). */
export interface ReleaseGate {
  windowSec: number;
  autoRollback: boolean;
  /** The error trip's floor (%); null = off (or a release recorded before the trip). */
  errorTripPct: number | null;
  configured: boolean;
}

/** Releases deployed WITHOUT a `swarmy.deploy.safety` label still settle out of `deploying` (never put back). */
export const DEFAULT_SETTLE_SEC = 120;

export function gateOf(healthGateJson: unknown): ReleaseGate {
  const g = healthGateJson as { windowSec?: unknown; autoRollback?: unknown; errorTripPct?: unknown } | null;
  const windowSec = Number(g?.windowSec);
  if (g && Number.isFinite(windowSec) && windowSec > 0) {
    const trip = typeof g.errorTripPct === 'number' && g.errorTripPct > 0 ? g.errorTripPct : null;
    return { windowSec: Math.round(windowSec), autoRollback: g.autoRollback === true, errorTripPct: trip, configured: true };
  }
  return { windowSec: DEFAULT_SETTLE_SEC, autoRollback: false, errorTripPct: null, configured: false };
}
