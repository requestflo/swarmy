/**
 * Workspace quiet hours (owner decision Q10) — pure and browser-safe, so the
 * controller's notify decision and the dashboard's "on now" word agree.
 *
 * The window is wall-clock `start`–`end` (HH:MM) in an IANA time zone.
 * `start > end` wraps past midnight (22:00–07:00); `start === end` is an
 * empty window (never quiet) rather than all day.
 */

export interface QuietHoursLike {
  enabled: boolean;
  start: string;
  end: string;
  timeZone: string;
}

/** "22:00" → 1320; malformed → null. */
export function parseHhmm(v: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since local midnight in `timeZone` (falls back to UTC on a bad zone). */
export function localMinutes(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** Is `now` inside the quiet window? Off / malformed / empty window → false. */
export function inQuietHours(q: QuietHoursLike | null | undefined, now: Date): boolean {
  if (!q?.enabled) return false;
  const start = parseHhmm(q.start);
  const end = parseHhmm(q.end);
  if (start === null || end === null || start === end) return false;
  const t = localMinutes(now, q.timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** "22:00–07:00" */
export function quietHoursRange(q: Pick<QuietHoursLike, 'start' | 'end'>): string {
  return `${q.start}–${q.end}`;
}
