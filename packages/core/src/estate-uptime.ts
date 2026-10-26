/**
 * Estate uptime — one number for the whole estate over 30 days: the share of
 * the time every app answered. Pure and browser-safe; the controller counts
 * the slots (`@swarmy/trpc` estate-uptime.ts), this module turns them into
 * the view.
 *
 * Two sources, judged the same way (a slot is down when anything in it was
 * not answering, never averaged away):
 *  - status checks: the status-page samples, one a minute per watched
 *    component (92 days kept). A minute is down when any component was DOWN;
 *    "degraded" still answered.
 *  - the edges' requests: the 5-minute edge traffic rollups (7 days kept). A
 *    bucket counts once an edge reported it; it is down when any routed app
 *    had at least {@link EDGE_DOWN_MIN_REQUESTS} requests and half or more of
 *    them got a 5xx.
 * Status checks win when they have enough history; else the edges; else "not
 * enough data" — never a made-up 100%.
 */

export const ESTATE_UPTIME_DAYS = 30;
/** Less than a day of slots in the window is not enough to say a number. */
export const ESTATE_UPTIME_MIN_HOURS = 24;
/** An app failing at least this share of a bucket's requests wasn't answering. */
export const EDGE_DOWN_5XX_SHARE = 0.5;
/** ...out of at least this many (one stray 502 is not an outage). */
export const EDGE_DOWN_MIN_REQUESTS = 5;
export const STATUS_CHECK_SLOT_MINUTES = 1;
export const EDGE_SLOT_MINUTES = 5;

export type EstateUptimeSource = 'status-checks' | 'edge-requests';

export interface EstateUptimeView {
  state: 'ok' | 'not-enough-data';
  /** 0..100, floored to 2 decimals (99.999 reads 99.99, never 100); null without enough data. */
  pct: number | null;
  /** What the number is from; null when neither source has anything. */
  source: EstateUptimeSource | null;
  windowDays: number;
  /** Hours of the window the source saw (≤ windowDays × 24). */
  coveredHours: number;
  /** Minutes in which something wasn't answering; null without enough data. */
  downMinutes: number | null;
}

/** Slots one source saw in the window, and how many of them were down. */
export interface UptimeSlots {
  slots: number;
  downSlots: number;
  slotMinutes: number;
}

/** Answered share, floored so any down slot keeps it below 100. */
export function uptimePct(slots: number, downSlots: number): number {
  if (slots <= 0) return 0;
  const down = Math.min(Math.max(downSlots, 0), slots);
  return Math.floor(((slots - down) / slots) * 10_000) / 100;
}

function hours(s: UptimeSlots, windowDays: number): number {
  return Math.min(windowDays * 24, Math.round(((s.slots * s.slotMinutes) / 60) * 10) / 10);
}

/** Pick the source and say the number (or that there isn't enough data). */
export function estateUptimeFrom(status: UptimeSlots, edges: UptimeSlots, windowDays = ESTATE_UPTIME_DAYS): EstateUptimeView {
  const sources: Array<[EstateUptimeSource, UptimeSlots]> = [
    ['status-checks', status],
    ['edge-requests', edges],
  ];
  const enough = sources.find(([, s]) => hours(s, windowDays) >= ESTATE_UPTIME_MIN_HOURS);
  if (enough) {
    const [source, s] = enough;
    const down = Math.min(Math.max(s.downSlots, 0), s.slots);
    return { state: 'ok', pct: uptimePct(s.slots, down), source, windowDays, coveredHours: hours(s, windowDays), downMinutes: down * s.slotMinutes };
  }
  const best = sources.filter(([, s]) => s.slots > 0).sort((a, b) => hours(b[1], windowDays) - hours(a[1], windowDays))[0];
  return {
    state: 'not-enough-data',
    pct: null,
    source: best?.[0] ?? null,
    windowDays,
    coveredHours: best ? hours(best[1], windowDays) : 0,
    downMinutes: null,
  };
}
