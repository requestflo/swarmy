import { wakeSpanWords, type WakeTimesView } from '@swarmy/core';

/**
 * "Wakes in about 2.1 s" (board AppScaling): what the activator measured for
 * this service's real wakes, the median, honestly empty before the first.
 * PURE — unit-tested in wake-words.test.ts.
 */
export function wakeWords(v: WakeTimesView | null | undefined, address: string | null): string | null {
  if (!v) return null;
  if (v.typicalMs === null) {
    return address
      ? `swarmy hasn’t timed a wake yet: the next visit to ${address} that finds it asleep will be.`
      : 'swarmy hasn’t timed a wake yet.';
  }
  const of = v.samples === 1 ? 'its one wake so far' : `the middle of its last ${v.samples} wakes`;
  return `Wakes in about ${wakeSpanWords(v.typicalMs)} (${of}).`;
}

/** The Controls line: the range and the newest. */
export function wakeTech(v: WakeTimesView): string {
  const range =
    v.fastestMs !== null && v.slowestMs !== null && v.samples > 1 ? ` · fastest ${wakeSpanWords(v.fastestMs)}, slowest ${wakeSpanWords(v.slowestMs)}` : '';
  const at = v.lastAt ? new Date(v.lastAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  const last = v.lastMs !== null && at ? ` · last ${wakeSpanWords(v.lastMs)} at ${at}` : '';
  return `services.wakeTimes · request in → visitor sent back to a running copy · controller memory${range}${last}`;
}
