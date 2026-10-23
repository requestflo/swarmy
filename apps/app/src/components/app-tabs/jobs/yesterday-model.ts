import type { JobRunView, ScheduledJobView } from '@swarmy/core';

/**
 * "Yesterday, hour by hour" (board AppJobs): each job's runs from yesterday
 * (UTC, the clock schedules run on) in 24 hourly cells, and the day in a
 * line. A failed run counts as retried when a later attempt of the same job
 * succeeded within the hour. PURE — unit-tested in yesterday-model.test.ts.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Window {
  from: number;
  to: number;
}

/** Yesterday, 00:00 to 24:00 UTC. */
export function yesterdayUtc(now: number): Window {
  const today = Math.floor(now / DAY) * DAY;
  return { from: today - DAY, to: today };
}

export interface Cell {
  runs: JobRunView[];
  failed: number;
}

export interface Lane {
  job: ScheduledJobView;
  cells: Cell[];
}

const failedRun = (r: JobRunView): boolean => r.status === 'failed' || r.status === 'timeout';

export function lanes(jobs: ScheduledJobView[], runs: Map<string, JobRunView[]>, w: Window): Lane[] {
  return jobs.map((job) => {
    const cells: Cell[] = Array.from({ length: 24 }, () => ({ runs: [], failed: 0 }));
    for (const r of runs.get(job.id) ?? []) {
      const t = Date.parse(r.startedAt);
      if (!(t >= w.from && t < w.to)) continue;
      const cell = cells[Math.floor((t - w.from) / HOUR)]!;
      cell.runs.push(r);
      if (failedRun(r)) cell.failed++;
    }
    for (const c of cells) c.runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { job, cells };
  });
}

/** A failed run whose next attempt (same job, higher attempt, within the hour) succeeded. */
export function retriedOk(r: JobRunView, all: JobRunView[]): boolean {
  const t = Date.parse(r.startedAt);
  return all.some((x) => x.status === 'succeeded' && x.attempt > r.attempt && Date.parse(x.startedAt) > t && Date.parse(x.startedAt) - t <= HOUR);
}

/** "98 runs · 2 failed, both retried ok" */
export function dayWords(ls: Lane[], runs: Map<string, JobRunView[]>): string {
  const day = ls.flatMap((l) => l.cells.flatMap((c) => c.runs));
  const failed = day.filter(failedRun);
  if (day.length === 0) return 'no runs';
  const head = `${day.length.toLocaleString()} run${day.length === 1 ? '' : 's'}`;
  if (failed.length === 0) return `${head} · none failed`;
  const ok = failed.filter((f) => retriedOk(f, runs.get(f.jobId) ?? [])).length;
  const tail = ok === failed.length ? (failed.length === 1 ? ', retried ok' : failed.length === 2 ? ', both retried ok' : ', all retried ok') : ok > 0 ? `, ${ok} retried ok` : '';
  return `${head} · ${failed.length} failed${tail}`;
}

/** "every day 02:00" → "Every day at 02:00 UTC"; null when the server only had the cron to say. */
export function plainSchedule(job: Pick<ScheduledJobView, 'schedule' | 'scheduleText'>): string | null {
  const t = job.scheduleText.trim();
  if (!t || t === job.schedule.trim()) return null;
  const at = t.replace(/(?<!at )(\b\d{2}:\d{2}\b)/, 'at $1');
  const words = at.charAt(0).toUpperCase() + at.slice(1);
  return /\d{2}:\d{2}/.test(words) ? `${words} UTC` : words;
}

/** "03:30" (UTC). */
export const hhmm = (iso: string): string => new Date(iso).toISOString().slice(11, 16);
