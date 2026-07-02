/**
 * Pure backup-schedule helpers (epic: volumes-dr, P2 — scheduler).
 *
 * No IO. We support a small "cron-ish" interval model rather than full cron:
 * `every` N minutes/hours/days from an anchor. This is deterministic and easy
 * to golden-test; the scheduler worker reads `nextRunAt` and advances it.
 */

export type IntervalUnit = 'minutes' | 'hours' | 'days';

export interface ScheduleSpec {
  every: number;
  unit: IntervalUnit;
}

const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function intervalMs(spec: ScheduleSpec): number {
  if (spec.every <= 0) throw new Error('schedule interval must be positive');
  return spec.every * UNIT_MS[spec.unit];
}

/**
 * Compute the next run strictly after `from`, aligned to `anchor` + k*interval.
 * Catch-up safe: if many intervals were missed (worker was down), it returns the
 * first slot in the future rather than replaying every missed slot.
 */
export function nextRun(spec: ScheduleSpec, anchor: Date, from: Date): Date {
  const step = intervalMs(spec);
  const anchorMs = anchor.getTime();
  const fromMs = from.getTime();
  if (fromMs < anchorMs) return new Date(anchorMs);
  const elapsed = fromMs - anchorMs;
  const k = Math.floor(elapsed / step) + 1;
  return new Date(anchorMs + k * step);
}

/** Whether a job with this `nextRunAt` is due as of `now`. */
export function isDue(nextRunAt: Date | null, now: Date): boolean {
  return nextRunAt != null && nextRunAt.getTime() <= now.getTime();
}

// ── 5-field cron (platform buildout: DB-backup schedules A1, scheduled jobs B2) ──
//
// A real (vixie-style) 5-field cron parser + evaluator, still pure/no-IO so it
// golden-tests like the interval model above. Per field we support `*`, lists
// `a,b,c`, ranges `a-b`, and steps `*/n` / `a-b/n`. Evaluation is **UTC**.
// Standard cron OR-rule: when BOTH day-of-month and day-of-week are restricted,
// a date matches if EITHER matches.

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether the day-of-month field was restricted (not `*`). */
  domRestricted: boolean;
  /** Whether the day-of-week field was restricted (not `*`). */
  dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (!part) throw new Error(`invalid cron ${name} field "${field}"`);
    const [rangePart = '', stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1 || (stepPart !== undefined && !/^\d+$/.test(stepPart))) {
      throw new Error(`invalid cron step in "${part}" (${name})`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (!a || !b || !/^\d+$/.test(a) || !/^\d+$/.test(b)) {
        throw new Error(`invalid cron range "${part}" (${name})`);
      }
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      if (!/^\d+$/.test(rangePart)) throw new Error(`invalid cron value "${part}" (${name})`);
      lo = Number.parseInt(rangePart, 10);
      // vixie-compat: `5/15` means 5..max step 15; a bare value is just itself.
      hi = stepPart === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron ${name} value out of range in "${part}" (${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty cron ${name} field "${field}"`);
  return out;
}

/** Parse a 5-field cron expression (minute hour dom month dow). Throws on invalid. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron "${expr}" must have exactly 5 fields (minute hour dom month dow)`);
  }
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseCronField(dow, 0, 7, 'day-of-week');
  if (daysOfWeek.has(7)) {
    // Both 0 and 7 mean Sunday.
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseCronField(m, 0, 59, 'minute'),
    hours: parseCronField(h, 0, 23, 'hour'),
    daysOfMonth: parseCronField(dom, 1, 31, 'day-of-month'),
    months: parseCronField(mon, 1, 12, 'month'),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** Whether `at` (truncated to its minute, UTC) matches the cron spec. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minutes.has(at.getUTCMinutes())) return false;
  if (!spec.hours.has(at.getUTCHours())) return false;
  if (!spec.months.has(at.getUTCMonth() + 1)) return false;
  const domOk = spec.daysOfMonth.has(at.getUTCDate());
  const dowOk = spec.daysOfWeek.has(at.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

const MINUTE_MS = 60_000;
/** Scan horizon: one (leap) year of minutes — covers every valid cron. */
const CRON_SCAN_LIMIT = 366 * 24 * 60;

function floorToMinute(d: Date): number {
  return Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** First occurrence strictly AFTER `from`, or null if none within a year. */
export function cronNext(spec: CronSpec, from: Date): Date | null {
  let t = floorToMinute(from) + MINUTE_MS;
  for (let i = 0; i < CRON_SCAN_LIMIT; i++, t += MINUTE_MS) {
    if (cronMatches(spec, new Date(t))) return new Date(t);
  }
  return null;
}

/** Most recent occurrence AT or BEFORE `from`, or null if none within a year. */
export function cronPrev(spec: CronSpec, from: Date): Date | null {
  let t = floorToMinute(from);
  for (let i = 0; i < CRON_SCAN_LIMIT; i++, t -= MINUTE_MS) {
    if (cronMatches(spec, new Date(t))) return new Date(t);
  }
  return null;
}

/**
 * Whether a cron schedule is due: its most recent occurrence at-or-before `now`
 * is strictly after the last completed run. A never-run schedule is due as soon
 * as one occurrence has passed (first backup lands promptly, then on cadence).
 * Catch-up safe: many missed slots collapse into a single run.
 */
export function isCronDue(spec: CronSpec, lastRunAt: Date | null, now: Date): boolean {
  const prev = cronPrev(spec, now);
  if (!prev) return false;
  return lastRunAt == null || lastRunAt.getTime() < prev.getTime();
}

// ── B2 scheduled jobs: nextRun batches, due rule, human descriptions ─────────

/** The next `count` occurrences strictly after `from` (may return fewer). */
export function cronNextN(spec: CronSpec, from: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = cronNext(spec, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * B2 due rule: a job fires when the next occurrence after its last fire
 * (`lastRunAt`, falling back to `createdAt` for never-run jobs) has passed.
 * Anchoring never-run jobs to `createdAt` means a job created after today's
 * slot waits for tomorrow's — creation is not a fire. Catch-up safe: however
 * many slots were missed, one fire advances `lastRunAt` past all of them.
 */
export function isJobDue(
  spec: CronSpec,
  lastRunAt: Date | null,
  createdAt: Date,
  now: Date,
): boolean {
  const next = cronNext(spec, lastRunAt ?? createdAt);
  return next != null && next.getTime() <= now.getTime();
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Detect "0,g,2g,…" uniform coverage → the step g; null otherwise. */
function uniformStep(values: Set<number>, max: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2 || sorted[0] !== 0) return null;
  const g = sorted[1] ?? 0;
  if (g <= 0) return null;
  if (sorted.length !== Math.floor(max / g) + 1) return null;
  return sorted.every((v, i) => v === i * g) ? g : null;
}

/**
 * Human description of a 5-field cron for the Jobs table ("every day 02:00",
 * "every Monday 09:30", "every 15 minutes"). Times are UTC. Falls back to the
 * raw expression for shapes it cannot phrase (still valid cron) and for
 * unparseable input (surfaced as invalid elsewhere).
 */
export function describeCron(expr: string): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return expr.trim();
  }
  const one = (s: Set<number>): number | null => (s.size === 1 ? [...s][0]! : null);
  const monthsAll = spec.months.size === 12;
  const minute = one(spec.minutes);
  const hour = one(spec.hours);
  const everyHour = spec.hours.size === 24;
  const anyDay = !spec.domRestricted && !spec.dowRestricted && monthsAll;

  // Sub-daily cadences: every N minutes / every N hours.
  if (anyDay && everyHour) {
    if (spec.minutes.size === 60) return 'every minute';
    const step = uniformStep(spec.minutes, 59);
    if (step) return `every ${step} minutes`;
    if (minute != null) return minute === 0 ? 'every hour' : `every hour at :${pad2(minute)}`;
  }
  if (anyDay && minute === 0) {
    const hourStep = uniformStep(spec.hours, 23);
    if (hourStep && hourStep > 1) return `every ${hourStep} hours`;
  }

  if (minute == null || hour == null || !monthsAll) return expr.trim();
  const at = `${pad2(hour)}:${pad2(minute)}`;

  if (!spec.domRestricted && !spec.dowRestricted) return `every day ${at}`;
  if (spec.dowRestricted && !spec.domRestricted) {
    const days = [...spec.daysOfWeek].sort((a, b) => a - b);
    if (days.length === 5 && WEEKDAYS.every((d) => spec.daysOfWeek.has(d))) {
      return `every weekday ${at}`;
    }
    if (days.length === 1) return `every ${DAY_NAMES[days[0]!]} ${at}`;
    if (days.length <= 3) return `every ${days.map((d) => DAY_NAMES[d]).join(', ')} ${at}`;
    return expr.trim();
  }
  if (spec.domRestricted && !spec.dowRestricted && spec.daysOfMonth.size === 1) {
    return `monthly on day ${[...spec.daysOfMonth][0]} at ${at}`;
  }
  return expr.trim();
}
