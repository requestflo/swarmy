import { MINUTE_MS, minuteOf } from './edge-traffic';

/**
 * The error trip on the deploy safety gate (board 35): while a release is
 * watched, the app's 5xx share at the edge (the hub's 1-minute traffic ring)
 * is held against what it was before the deploy. When it stays above the
 * line for {@link ERROR_TRIP_FOR_MIN} full minutes the gate fails the
 * release, the same way a failed health check does (put back when the app
 * asks for it). PURE: the worker reads the ring, this decides.
 *
 * The line is {@link ERROR_TRIP_FACTOR}× the share in the
 * {@link ERROR_TRIP_BASELINE_MIN} minutes before the deploy, and never
 * below the app's floor (2% unless set). A minute counts only with at least
 * {@link ERROR_TRIP_MIN_REQUESTS} requests, so a quiet app never trips on
 * one error; a baseline needs {@link ERROR_TRIP_BASELINE_MIN_REQUESTS}, else
 * the floor alone is the line.
 */

export const ERROR_TRIP_FACTOR = 3;
/** The floor when the `swarmy.deploy.safety` label doesn't name one. */
export const ERROR_TRIP_DEFAULT_PCT = 2;
/** The floors the dashboard offers (any 0.5–50 is accepted). */
export const ERROR_TRIP_CHOICES = [2, 5, 10] as const;
export const ERROR_TRIP_FOR_MIN = 2;
export const ERROR_TRIP_MIN_REQUESTS = 10;
export const ERROR_TRIP_BASELINE_MIN = 30;
export const ERROR_TRIP_BASELINE_MIN_REQUESTS = 50;
/** A minute is judged only once its late edge samples have landed. */
export const ERROR_TRIP_GRACE_MS = 30_000;

/** One minute of an app's requests at the edge (every edge, every host of the app). */
export interface AppMinute {
  t: number;
  requests: number;
  errors5xx: number;
}

/**
 * The floor from the label's `errorTripPct`: absent → the default (the
 * trip is part of the gate), `null`/`false`/0 → off, else clamped to 0.5–50.
 */
export function parseErrorTripPct(v: unknown): number | null {
  if (v === undefined || v === true) return ERROR_TRIP_DEFAULT_PCT;
  if (v === null || v === false) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(50, Math.max(0.5, n));
}

/** With the trip on, the gate watches at least this long: room for the full minutes it needs. */
export function errorTripWatchSec(): number {
  return (ERROR_TRIP_FOR_MIN + 2) * 60;
}

/** The newest minute that is complete (and past its grace) at `now`: the trip's signature. */
export function errorTripThrough(now: number): number {
  return minuteOf(now - MINUTE_MS - ERROR_TRIP_GRACE_MS);
}

export interface ErrorTripDecision {
  trip: boolean;
  /** 5xx share (%) in the minutes before the deploy; null when too quiet to say. */
  baselinePct: number | null;
  /** The line (%): the larger of the floor and 3× the baseline. */
  thresholdPct: number;
  /** The share (%) over the minutes that tripped it; null when it didn't. */
  failedPct: number | null;
  /** The last complete minute judged; null before the first one. */
  judgedThrough: number | null;
}

const share = (errors: number, requests: number): number => (requests > 0 ? (errors / requests) * 100 : 0);

export function decideErrorTrip(input: { minutes: readonly AppMinute[]; deployedAt: number; now: number; floorPct: number }): ErrorTripDecision {
  const byT = new Map<number, { requests: number; errors5xx: number }>();
  for (const m of input.minutes) {
    const c = byT.get(m.t) ?? { requests: 0, errors5xx: 0 };
    c.requests += m.requests;
    c.errors5xx += m.errors5xx;
    byT.set(m.t, c);
  }
  const deployMinute = minuteOf(input.deployedAt);
  let bReq = 0;
  let bErr = 0;
  for (let t = deployMinute - ERROR_TRIP_BASELINE_MIN * MINUTE_MS; t < deployMinute; t += MINUTE_MS) {
    bReq += byT.get(t)?.requests ?? 0;
    bErr += byT.get(t)?.errors5xx ?? 0;
  }
  const baselinePct = bReq >= ERROR_TRIP_BASELINE_MIN_REQUESTS ? share(bErr, bReq) : null;
  const thresholdPct = Math.max(input.floorPct, ERROR_TRIP_FACTOR * (baselinePct ?? 0));
  // Only whole minutes after the deploy began: the deploy's own minute mixes old and new.
  const through = errorTripThrough(input.now);
  let run: Array<{ requests: number; errors5xx: number }> = [];
  let tripped: typeof run | null = null;
  let judgedThrough: number | null = null;
  for (let t = Math.ceil(input.deployedAt / MINUTE_MS) * MINUTE_MS; t <= through; t += MINUTE_MS) {
    judgedThrough = t;
    const m = byT.get(t) ?? { requests: 0, errors5xx: 0 };
    if (m.requests >= ERROR_TRIP_MIN_REQUESTS && share(m.errors5xx, m.requests) > thresholdPct) run.push(m);
    else run = [];
    if (!tripped && run.length >= ERROR_TRIP_FOR_MIN) tripped = run.slice(-ERROR_TRIP_FOR_MIN);
  }
  const failedPct = tripped
    ? share(tripped.reduce((n, m) => n + m.errors5xx, 0), tripped.reduce((n, m) => n + m.requests, 0))
    : null;
  return { trip: tripped !== null, baselinePct, thresholdPct, failedPct, judgedThrough };
}

/** "0.4%", "7%", "12%". */
export function tripPctWords(v: number): string {
  return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}%`;
}

/** Why it tripped, in plain words: "7% of requests failed, up from 0.4%". */
export function errorTripReason(d: Pick<ErrorTripDecision, 'baselinePct' | 'thresholdPct' | 'failedPct'>): string {
  const failed = tripPctWords(d.failedPct ?? 0);
  return d.baselinePct === null
    ? `${failed} of requests failed, above the ${tripPctWords(d.thresholdPct)} line`
    : `${failed} of requests failed, up from ${tripPctWords(d.baselinePct)}`;
}

/** The release's timeline line once it was put back: "Stopped: 7% of requests failed, up from 0.4%". */
export function errorTripWords(d: Pick<ErrorTripDecision, 'baselinePct' | 'thresholdPct' | 'failedPct'>): string {
  return `Stopped: ${errorTripReason(d)}`;
}
