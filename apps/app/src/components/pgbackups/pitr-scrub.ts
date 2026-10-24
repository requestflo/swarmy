/**
 * Point-in-time maths for the restore scrubber: the window swarmy can restore
 * to (`dbBackups.overview` → `pitrWindow`), the click strip across it, the
 * ±10 s nudges and the exact time typed at Controls. Everything is UTC and
 * whole seconds, the same form the restore's `targetTime` takes.
 */

export const NUDGE_MS = 10_000;
/** Click targets across the window (the board's 6-hour blocks over 7 days). */
export const SEGMENTS = 28;

const DAY_MS = 86_400_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number): string => String(n).padStart(2, '0');

export interface PitSpan {
  fromMs: number;
  toMs: number;
}

/** The restorable span in whole seconds, or null when there isn't one. */
export function pitSpan(w: { from: string; to: string } | null | undefined): PitSpan | null {
  if (!w) return null;
  const fromMs = Math.ceil(Date.parse(w.from) / 1000) * 1000;
  const toMs = Math.floor(Date.parse(w.to) / 1000) * 1000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return { fromMs, toMs };
}

type Window = { from: string; to: string };
export type PitWindowSource = 'agent' | 'estimate';

/**
 * The window the scrubber spans: the agent's read of the WAL repo
 * (`dbBackups.pitrWindow`) when it has one, else the overview's (its last
 * read, or the schedule's estimate). A read with no base backups is no window.
 */
export function pickPitrWindow(
  read: { source: string; window: Window | null } | null | undefined,
  row: { pitrWindow: Window | null; pitrWindowSource?: PitWindowSource } | null | undefined,
): { window: Window | null; source: PitWindowSource | null } {
  if (read?.source === 'agent') return { window: read.window, source: 'agent' };
  if (row?.pitrWindow) return { window: row.pitrWindow, source: row.pitrWindowSource ?? 'estimate' };
  return { window: null, source: null };
}

/** Round to the second and keep inside the span. */
export function clampPit(ms: number, span: PitSpan): number {
  return Math.min(span.toMs, Math.max(span.fromMs, Math.round(ms / 1000) * 1000));
}

/** `steps` × 10 s earlier (negative) or later, never leaving the span. */
export function nudgePit(ms: number, steps: number, span: PitSpan): number {
  return clampPit(ms + steps * NUDGE_MS, span);
}

export interface PitSegment {
  index: number;
  startMs: number;
  endMs: number;
  /** Where a click on this block lands. */
  midMs: number;
}

export function pitSegments(span: PitSpan, n = SEGMENTS): PitSegment[] {
  const len = (span.toMs - span.fromMs) / n;
  return Array.from({ length: n }, (_, index) => {
    const startMs = span.fromMs + index * len;
    const endMs = index === n - 1 ? span.toMs : startMs + len;
    return { index, startMs, endMs, midMs: clampPit((startMs + endMs) / 2, span) };
  });
}

/** Which block a time falls in. */
export function segmentOf(ms: number, span: PitSpan, n = SEGMENTS): number {
  const len = (span.toMs - span.fromMs) / n;
  return Math.min(n - 1, Math.max(0, Math.floor((ms - span.fromMs) / len)));
}

/** Whole days the span covers (at least 1), for "any second in the last N days". */
export function spanDays(span: PitSpan): number {
  return Math.max(1, Math.round((span.toMs - span.fromMs) / DAY_MS));
}

/** Evenly spaced day labels under the strip; the right end is the latest point. */
export function pitAxis(span: PitSpan, count = 5): { frac: number; label: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const frac = count === 1 ? 1 : i / (count - 1);
    const d = new Date(span.fromMs + frac * (span.toMs - span.fromMs));
    return { frac, label: i === count - 1 ? 'latest' : `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}` };
  });
}

/** "Sun 21 Sep · 03:02:07" (UTC). */
export function formatPit(ms: number): string {
  const d = new Date(ms);
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} · ${time}`;
}

/** The Controls text box form: "2026-09-21 03:02:07" (UTC). */
export function pitInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Parse "2026-09-21 03:02:07", "2026-09-21T03:02" or a full ISO time as UTC; null if it isn't one. */
export function parsePit(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|\+00:00)?$/i.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  // Reject roll-overs ("2026-02-31") rather than silently moving the day.
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return ms;
}
