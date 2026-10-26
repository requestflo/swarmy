/**
 * Cold-start time for scale-to-zero services (board 34: "wakes in about
 * 2.1 s"). The activator holds a visitor's first request to a sleeping
 * service while a copy starts; one sample is that wait, from the request
 * arriving until swarmy saw a running (healthy, when it has a check) copy and
 * the edge was re-rendered to serve it directly: the moment the visitor is
 * sent back. Only real wakes count: a request that finds a copy already
 * running is no cold start. Kept in controller memory, the last
 * {@link WAKE_SAMPLES_KEPT} per service. PURE: the summary and its words.
 */

/** Recent wakes kept per service. */
export const WAKE_SAMPLES_KEPT = 20;

export interface WakeSample {
  /** When the wake finished (ms). */
  at: number;
  /** Request in → visitor sent back (ms). */
  ms: number;
}

export interface WakeTimesView {
  /** How many wakes this controller measured (at most {@link WAKE_SAMPLES_KEPT}). */
  samples: number;
  /** The median wake (ms), null with none measured. */
  typicalMs: number | null;
  fastestMs: number | null;
  slowestMs: number | null;
  /** The newest wake: when, and how long it took. */
  lastAt: string | null;
  lastMs: number | null;
}

/** Keep the newest {@link WAKE_SAMPLES_KEPT}, oldest first. */
export function keepWakeSamples(samples: readonly WakeSample[], next: WakeSample): WakeSample[] {
  return [...samples, next].sort((a, b) => a.at - b.at).slice(-WAKE_SAMPLES_KEPT);
}

export function wakeTimesView(samples: readonly WakeSample[]): WakeTimesView {
  if (samples.length === 0) return { samples: 0, typicalMs: null, fastestMs: null, slowestMs: null, lastAt: null, lastMs: null };
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  const typical = ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
  const last = [...samples].sort((a, b) => a.at - b.at).at(-1)!;
  return {
    samples: samples.length,
    typicalMs: Math.round(typical),
    fastestMs: ms[0]!,
    slowestMs: ms.at(-1)!,
    lastAt: new Date(last.at).toISOString(),
    lastMs: last.ms,
  };
}

/** "0.8 s", "2.1 s", "14 s", "1 min 5 s". */
export function wakeSpanWords(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${Math.max(0.1, Math.round(s * 10) / 10)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  const rest = Math.round(s - min * 60);
  return rest ? `${min} min ${rest} s` : `${min} min`;
}
