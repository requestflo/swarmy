/**
 * whenever's `config/schedule.rb` → five-field schedules and the command each
 * block runs. Only the common forms: `every 1.day, at: '4:30 am'`,
 * `every :hour`, `every 10.minutes`, `every :monday, at: '9am'` and a raw
 * cron string; a `rake` / `runner` / `command` line inside the block. Anything
 * else is skipped (fewer jobs, never a wrong one).
 */
import { isCron } from '../units';
import type { ScanFile, ScanLine } from './types';

export interface WheneverJob {
  schedule: string;
  command: string;
  /** A unit name hint (the rake task, the runner's class). */
  hint: string;
  line: ScanLine;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** `'4:30 am'` / `'12pm'` / `'16:00'` → [minute, hour]. */
export function atTime(raw: string): [number, number] | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h < 24 && min < 60 ? [min, h] : null;
}

/** The `every …` arguments → a cron line, or null when the form isn't one we read. */
export function everyToCron(args: string): string | null {
  const raw = /^['"]([^'"]+)['"]/.exec(args)?.[1];
  if (raw) return isCron(raw) ? raw : null;
  const at = /at:\s*\[?\s*['"]([^'"]+)['"]/.exec(args)?.[1];
  const time = at ? atTime(at) : [0, 0];
  if (!time) return null;
  const [min, hour] = time;
  const sym = /^:(\w+)/.exec(args)?.[1];
  const num = /^(\d+)\.(minute|hour|day|week|month)s?\b/.exec(args);
  const unit = sym ?? (num && Number(num[1]) === 1 ? num[2] : undefined);
  if (sym && DAYS.includes(sym)) return `${min} ${hour} * * ${DAYS.indexOf(sym)}`;
  if (unit === 'minute') return '* * * * *';
  if (unit === 'hour') return '0 * * * *';
  if (unit === 'day') return `${min} ${hour} * * *`;
  if (unit === 'week') return `${min} ${hour} * * 0`;
  if (unit === 'month') return `${min} ${hour} 1 * *`;
  if (!num) return null;
  const n = Number(num[1]);
  if (num[2] === 'minute' && n < 60) return `*/${n} * * * *`;
  if (num[2] === 'hour' && n < 24) return `0 */${n} * * *`;
  if (num[2] === 'day' && n < 32) return `${min} ${hour} */${n} * *`;
  return null;
}

/** `rake "invoices:send"` → `bundle exec rake invoices:send`, … */
function commandOf(t: string): { command: string; hint: string } | null {
  const m = /^(rake|runner|command)\s+['"]([^'"]+)['"]/.exec(t);
  if (!m) return null;
  const arg = m[2]!;
  if (m[1] === 'rake') return { command: `bundle exec rake ${arg}`, hint: arg.split(':').pop() ?? arg };
  if (m[1] === 'runner') return { command: `bundle exec rails runner ${JSON.stringify(arg)}`, hint: arg.split(/[.:(\s]/)[0] ?? 'runner' };
  return { command: arg, hint: arg.split(/\s+/)[0]!.split('/').pop() ?? 'command' };
}

export function wheneverJobs(f: ScanFile, max = 5): WheneverJob[] {
  const out: WheneverJob[] = [];
  let open: { schedule: string; line: ScanLine } | null = null;
  for (const l of f.lines) {
    const t = l.text.trim();
    const every = /^every\s+(.+?)\s+do\b/.exec(t);
    if (every) {
      const schedule = everyToCron(every[1]!);
      open = schedule ? { schedule, line: l } : null;
      continue;
    }
    if (/^end\b/.test(t)) open = null;
    const cmd = open ? commandOf(t) : null;
    if (open && cmd) {
      out.push({ schedule: open.schedule, ...cmd, line: open.line });
      open = null;
      if (out.length >= max) break;
    }
  }
  return out;
}
