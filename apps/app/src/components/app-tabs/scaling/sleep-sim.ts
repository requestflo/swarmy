/**
 * "Yesterday, if it had slept" (board AppScaling): replay a day of request
 * buckets through the sleeper's rule — scale to zero once nothing has asked
 * for `idleMs`, wake on the next request. PURE — unit-tested in sleep-sim.test.ts.
 *
 * Buckets only say "some requests" or "none", so a busy bucket counts as
 * awake end to end and the idle clock starts at its end: the estimate never
 * sleeps through a request. It also assumes the service was busy right up to
 * the window's start, so no nap is credited before the data begins.
 */

export interface CallBucket {
  /** Bucket start (ms). */
  t: number;
  calls: number;
}

export interface SimSlot {
  t: number;
  calls: number;
  /** How much of this slot it would have spent asleep. */
  asleepMs: number;
}

export interface SleepSim {
  slots: SimSlot[];
  /** Total time it would have spent asleep. */
  asleepMs: number;
  /** Separate naps. */
  naps: number;
  /** Naps a request ended: each of those requests finds it asleep. */
  wakes: number;
  calls: number;
}

export function simulateSleep({
  from,
  to,
  bucketMs,
  buckets,
  idleMs,
}: {
  from: number;
  to: number;
  bucketMs: number;
  buckets: CallBucket[];
  idleMs: number;
}): SleepSim {
  const n = Math.max(0, Math.ceil((to - from) / bucketMs));
  const calls = new Array<number>(n).fill(0);
  for (const b of buckets) {
    const i = Math.floor((b.t - from) / bucketMs);
    if (i >= 0 && i < n && b.calls > 0) calls[i]! += b.calls;
  }
  const slots: SimSlot[] = [];
  let idleSince = from;
  let asleep = false;
  let asleepMs = 0;
  let naps = 0;
  let wakes = 0;
  for (let i = 0; i < n; i++) {
    const t = from + i * bucketMs;
    const c = calls[i]!;
    if (c > 0) {
      if (asleep) wakes++;
      asleep = false;
      idleSince = t + bucketMs;
      slots.push({ t, calls: c, asleepMs: 0 });
      continue;
    }
    const sleepsAt = Math.max(t, idleSince + idleMs);
    const ms = Math.max(0, Math.min(bucketMs, t + bucketMs - sleepsAt));
    if (ms > 0 && !asleep) {
      naps++;
      asleep = true;
    }
    asleepMs += ms;
    slots.push({ t, calls: 0, asleepMs: ms });
  }
  return { slots, asleepMs, naps, wakes, calls: calls.reduce((a, b) => a + b, 0) };
}

/** Fold fine slots into wider bars for drawing (calls and sleep add up). */
export function foldSlots(slots: SimSlot[], per: number): SimSlot[] {
  const out: SimSlot[] = [];
  for (let i = 0; i < slots.length; i += per) {
    const group = slots.slice(i, i + per);
    out.push({
      t: group[0]!.t,
      calls: group.reduce((a, s) => a + s.calls, 0),
      asleepMs: group.reduce((a, s) => a + s.asleepMs, 0),
    });
  }
  return out;
}

/** "7.5 h" · "40 min" — rounded to the half hour above an hour. */
export function sleptWords(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.round((ms / 3_600_000) * 2) / 2} h`;
}

/** The idle presets the board offers, and their words. */
export const IDLE_PRESETS = [300, 900, 3600] as const;

export function idleWords(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/** The compose/swarmy.yaml duration dialect: `15m`, `1h`, `90s`. */
export function idleDuration(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
