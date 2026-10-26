/**
 * The error trip's watcher half (deploy-safety worker). The decision is pure
 * (`@swarmy/core` `decideErrorTrip`); this only reads the app's minutes and
 * gates on a signature: the newest complete minute. A tick inside the same
 * minute as the last look reads nothing — the ring's complete minutes can't
 * have changed — so at the 15 s tick three looks in four are free. The
 * minutes come in through `read` (the worker passes `appTrafficMinutes`), so
 * this file imports only `@swarmy/core` and tests run without the router graph.
 */
import {
  ERROR_TRIP_BASELINE_MIN,
  MINUTE_MS,
  decideErrorTrip,
  errorTripReason,
  errorTripThrough,
  minuteOf,
  type AppMinute,
} from '@swarmy/core';

/** release id → the last complete minute judged. */
const judged = new Map<string, number>();

/**
 * Has `release` tripped? The reason in plain words, or null (no trip, or no
 * new complete minute since the last look).
 */
export function errorTripCheck(
  read: (from: number, to: number) => AppMinute[],
  release: { id: string; createdAt: Date },
  floorPct: number,
  now = Date.now(),
): string | null {
  const through = errorTripThrough(now);
  if (judged.get(release.id) === through) return null;
  judged.set(release.id, through);
  const deployedAt = release.createdAt.getTime();
  const minutes = read(minuteOf(deployedAt) - ERROR_TRIP_BASELINE_MIN * MINUTE_MS, now);
  const d = decideErrorTrip({ minutes, deployedAt, now, floorPct });
  return d.trip ? errorTripReason(d) : null;
}

/** Drop signatures of releases no longer watched. */
export function forgetErrorTrips(watching: ReadonlySet<string>): void {
  for (const id of judged.keys()) if (!watching.has(id)) judged.delete(id);
}
