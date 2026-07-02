import type {
  CreateScheduledJobInput,
  JobRunView,
  JobRunsPage,
  JobsOverview,
  SchedulePreview,
  ScheduledJobView,
  UpdateScheduledJobInput,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Scheduled-jobs demo resolvers — the Jobs surface (`/jobs`): cron jobs,
 * run-now, run history and output tails. Return shapes mirror
 * `jobs.service.ts` views exactly (imported from @swarmy/core, never
 * redeclared). The cron evaluator below is a compact pure mirror of
 * `@swarmy/trpc` schedule.ts (canonical, unit-tested there) — demo code runs
 * in the browser and cannot import server modules.
 */

// ── cron mirror (UTC, vixie 5-field, dom/dow OR rule, 7 == Sunday) ───────────

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domR: boolean;
  dowR: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (!part) throw new Error(`invalid cron field "${field}"`);
    const [rangePart = '', stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step in "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a = '', b = ''] = rangePart.split('-');
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      lo = Number.parseInt(rangePart, 10);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range in "${part}" (${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron "${expr}" must have exactly 5 fields (minute hour dom month dow)`);
  }
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const dowSet = parseField(dow, 0, 7);
  if (dowSet.has(7)) {
    dowSet.delete(7);
    dowSet.add(0);
  }
  return {
    minutes: parseField(m, 0, 59),
    hours: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12),
    dow: dowSet,
    domR: dom !== '*',
    dowR: dow !== '*',
  };
}

function cronMatches(s: CronSpec, at: Date): boolean {
  if (!s.minutes.has(at.getUTCMinutes()) || !s.hours.has(at.getUTCHours())) return false;
  if (!s.months.has(at.getUTCMonth() + 1)) return false;
  const domOk = s.dom.has(at.getUTCDate());
  const dowOk = s.dow.has(at.getUTCDay());
  if (s.domR && s.dowR) return domOk || dowOk;
  if (s.domR) return domOk;
  if (s.dowR) return dowOk;
  return true;
}

const MIN = 60_000;

function cronNext(s: CronSpec, from: Date): Date | null {
  let t = Math.floor(from.getTime() / MIN) * MIN + MIN;
  for (let i = 0; i < 366 * 24 * 60; i++, t += MIN) {
    if (cronMatches(s, new Date(t))) return new Date(t);
  }
  return null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Compact mirror of schedule.ts `describeCron` for the common shapes. */
function describeCron(expr: string): string {
  let s: CronSpec;
  try {
    s = parseCron(expr);
  } catch {
    return expr.trim();
  }
  const one = (set: Set<number>): number | null => (set.size === 1 ? [...set][0]! : null);
  const minute = one(s.minutes);
  const hour = one(s.hours);
  const anyDay = !s.domR && !s.dowR && s.months.size === 12;
  if (anyDay && s.hours.size === 24) {
    if (s.minutes.size === 60) return 'every minute';
    const sorted = [...s.minutes].sort((a, b) => a - b);
    const g = sorted[1] ?? 0;
    if (sorted.length > 1 && sorted[0] === 0 && sorted.every((v, i) => v === i * g)) {
      return `every ${g} minutes`;
    }
    if (minute != null) return minute === 0 ? 'every hour' : `every hour at :${pad2(minute)}`;
  }
  if (minute == null || hour == null || s.months.size !== 12) return expr.trim();
  const at = `${pad2(hour)}:${pad2(minute)}`;
  if (!s.domR && !s.dowR) return `every day ${at}`;
  if (s.dowR && !s.domR) {
    const days = [...s.dow].sort((a, b) => a - b);
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => s.dow.has(d))) return `every weekday ${at}`;
    if (days.length === 1) return `every ${DAYS[days[0]!]} ${at}`;
    if (days.length <= 3) return `every ${days.map((d) => DAYS[d]).join(', ')} ${at}`;
  }
  if (s.domR && !s.dowR && s.dom.size === 1) return `monthly on day ${[...s.dom][0]} at ${at}`;
  return expr.trim();
}

// ── demo state ───────────────────────────────────────────────────────────────

interface JobSeed {
  id: string;
  name: string;
  schedule: string;
  kind: ScheduledJobView['kind'];
  image: string | null;
  serviceRef: string | null;
  command: string[];
  env: Record<string, string>;
  runOn: ScheduledJobView['runOn'];
  timeoutMs: number;
  retries: number;
  alertOnFailure: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

interface JobsState {
  jobs: JobSeed[];
  runs: JobRunView[];
}

const getState = (store: DemoStore): JobsState => store.extra.jobs as JobsState;
const id = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function toView(job: JobSeed, runs: JobRunView[]): ScheduledJobView {
  const last = runs.find((r) => r.jobId === job.id) ?? null; // runs are newest-first
  let nextRunAt: string | null = null;
  if (job.enabled) {
    try {
      nextRunAt = cronNext(parseCron(job.schedule), new Date())?.toISOString() ?? null;
    } catch {
      nextRunAt = null;
    }
  }
  return {
    ...job,
    scheduleText: describeCron(job.schedule),
    lastRunStatus: last?.status ?? null,
    nextRunAt,
  };
}

function pushRun(state: JobsState, run: JobRunView): void {
  state.runs = [run, ...state.runs];
}

// ── resolvers ────────────────────────────────────────────────────────────────

export const jobs: DomainResolvers = {
  handlers: {
    'jobs.overview': (_i, s): JobsOverview => {
      const st = getState(s);
      const dayAgo = Date.now() - DAY;
      const recent = st.runs.filter((r) => new Date(r.startedAt).getTime() >= dayAgo);
      const views = st.jobs.map((j) => toView(j, st.runs));
      const next = views
        .filter((v) => v.nextRunAt)
        .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))[0];
      return {
        total: st.jobs.length,
        enabled: st.jobs.filter((j) => j.enabled).length,
        succeeded24h: recent.filter((r) => r.status === 'succeeded').length,
        failed24h: recent.filter((r) => r.status === 'failed' || r.status === 'timeout').length,
        nextRunAt: next?.nextRunAt ?? null,
        nextJobName: next?.name ?? null,
      };
    },

    'jobs.list': (_i, s): ScheduledJobView[] => {
      const st = getState(s);
      return [...st.jobs].sort((a, b) => a.name.localeCompare(b.name)).map((j) => toView(j, st.runs));
    },

    'jobs.previewSchedule': (i, _s): SchedulePreview => {
      const { schedule, count = 3 } = i as { schedule: string; count?: number };
      let spec: CronSpec;
      try {
        spec = parseCron(schedule);
      } catch (e) {
        return {
          valid: false,
          scheduleText: schedule.trim(),
          next: [],
          error: e instanceof Error ? e.message : 'invalid cron expression',
        };
      }
      const next: string[] = [];
      let cursor = new Date();
      for (let n = 0; n < count; n++) {
        const occ = cronNext(spec, cursor);
        if (!occ) break;
        next.push(occ.toISOString());
        cursor = occ;
      }
      return { valid: true, scheduleText: describeCron(schedule), next, error: null };
    },

    'jobs.runs': (i, s): JobRunsPage => {
      const { jobId, cursor, limit = 25 } = i as { jobId: string; cursor?: string; limit?: number };
      const all = getState(s).runs.filter((r) => r.jobId === jobId);
      const start = cursor ? all.findIndex((r) => r.id === cursor) + 1 : 0;
      const page = all.slice(start, start + limit);
      return {
        runs: page,
        nextCursor: start + limit < all.length ? (page[page.length - 1]?.id ?? null) : null,
      };
    },

    'jobs.create': (i, s): ScheduledJobView => {
      const input = i as CreateScheduledJobInput;
      parseCron(input.schedule); // throws the parser message for invalid crons
      const st = getState(s);
      if (st.jobs.some((j) => j.name === input.name)) {
        throw new Error(`a job named "${input.name}" already exists`);
      }
      const job: JobSeed = {
        id: id('job'),
        name: input.name,
        schedule: input.schedule,
        kind: input.kind ?? 'image',
        image: input.image ?? null,
        serviceRef: input.serviceRef ?? null,
        command: input.command ?? [],
        env: input.env ?? {},
        runOn: input.runOn ?? {},
        timeoutMs: input.timeoutMs ?? 600_000,
        retries: input.retries ?? 0,
        alertOnFailure: input.alertOnFailure ?? true,
        enabled: input.enabled ?? true,
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };
      st.jobs.push(job);
      return toView(job, st.runs);
    },

    'jobs.update': (i, s): ScheduledJobView => {
      const input = i as UpdateScheduledJobInput;
      const st = getState(s);
      const job = st.jobs.find((j) => j.id === input.id);
      if (!job) throw new Error(`job "${input.id}" not found`);
      if (input.schedule) parseCron(input.schedule);
      Object.assign(job, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
        ...(input.serviceRef !== undefined ? { serviceRef: input.serviceRef } : {}),
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.runOn !== undefined ? { runOn: input.runOn } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.retries !== undefined ? { retries: input.retries } : {}),
        ...(input.alertOnFailure !== undefined ? { alertOnFailure: input.alertOnFailure } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      return toView(job, st.runs);
    },

    'jobs.remove': (i, s): { id: string } => {
      const { id: jobId } = i as { id: string };
      const st = getState(s);
      st.jobs = st.jobs.filter((j) => j.id !== jobId);
      st.runs = st.runs.filter((r) => r.jobId !== jobId);
      return { id: jobId };
    },

    'jobs.toggle': (i, s): ScheduledJobView => {
      const { id: jobId, enabled } = i as { id: string; enabled: boolean };
      const st = getState(s);
      const job = st.jobs.find((j) => j.id === jobId);
      if (!job) throw new Error(`job "${jobId}" not found`);
      job.enabled = enabled;
      return toView(job, st.runs);
    },

    'jobs.runNow': (i, s): { jobId: string; runId: string } => {
      const { id: jobId } = i as { id: string };
      const st = getState(s);
      const job = st.jobs.find((j) => j.id === jobId);
      if (!job) throw new Error(`job "${jobId}" not found`);
      job.lastRunAt = new Date().toISOString();
      const run: JobRunView = {
        id: id('run'),
        jobId: job.id,
        status: 'running',
        exitCode: null,
        outputTail: null,
        attempt: 1,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      pushRun(st, run);
      // Settle shortly so the polling drawer shows the run completing live.
      setTimeout(() => {
        run.status = 'succeeded';
        run.exitCode = 0;
        run.finishedAt = new Date().toISOString();
        run.outputTail =
          job.kind === 'image'
            ? `pulling ${job.image}\n${job.command.slice(-1)[0] ?? ''}\ndone in 4.2s`
            : `$ ${job.command.slice(-1)[0] ?? ''}\nOK`;
      }, 4_500);
      return { jobId: job.id, runId: run.id };
    },

    'jobs.cancelRun': (i, s): JobRunView => {
      const { runId } = i as { runId: string };
      const run = getState(s).runs.find((r) => r.id === runId);
      if (!run) throw new Error(`job run "${runId}" not found`);
      if (run.status === 'running') {
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        run.outputTail = '[cancelled by user]';
      }
      return run;
    },
  },

  seed: (store) => {
    // Three jobs with believable history: a healthy nightly report, an hourly
    // service exec, and a weekly cleanup whose last run failed (alerting).
    const jobs: JobSeed[] = [
      {
        id: 'job-nightly-report',
        name: 'nightly-report',
        schedule: '0 2 * * *',
        kind: 'image',
        image: 'ghcr.io/northwind/report-runner:1.4.2',
        serviceRef: null,
        command: ['sh', '-c', 'node dist/report.js --day yesterday'],
        env: { REPORT_BUCKET: 'northwind-reports', TZ: 'UTC' },
        runOn: {},
        timeoutMs: 900_000,
        retries: 1,
        alertOnFailure: true,
        enabled: true,
        lastRunAt: iso(10 * HOUR),
        createdAt: iso(30 * DAY),
      },
      {
        id: 'job-cache-warmup',
        name: 'cache-warmup',
        schedule: '0 * * * *',
        kind: 'service-exec',
        image: null,
        serviceRef: 'storefront_api',
        command: ['sh', '-c', 'node scripts/warm-cache.js --top 500'],
        env: {},
        runOn: {},
        timeoutMs: 300_000,
        retries: 0,
        alertOnFailure: false,
        enabled: true,
        lastRunAt: iso(0.4 * HOUR),
        createdAt: iso(12 * DAY),
      },
      {
        id: 'job-weekly-cleanup',
        name: 'weekly-cleanup',
        schedule: '0 3 * * 1',
        kind: 'image',
        image: 'ghcr.io/northwind/janitor:0.9.1',
        serviceRef: null,
        command: ['sh', '-c', 'janitor prune --older-than 90d'],
        env: { DRY_RUN: 'false' },
        runOn: { labels: { storage: 'bulk' } },
        timeoutMs: 1_800_000,
        retries: 2,
        alertOnFailure: true,
        enabled: true,
        lastRunAt: iso(3 * DAY),
        createdAt: iso(60 * DAY),
      },
    ];

    const run = (
      jobId: string,
      agoMs: number,
      status: JobRunView['status'],
      attempt: number,
      exitCode: number | null,
      durationMs: number,
      outputTail: string,
    ): JobRunView => ({
      id: id('run'),
      jobId,
      status,
      exitCode,
      outputTail,
      attempt,
      startedAt: iso(agoMs),
      finishedAt: status === 'running' ? null : iso(agoMs - durationMs),
    });

    const reportOut = 'rendering 42 pages\nuploading s3://northwind-reports/2026-07-01.pdf\ndone in 38.1s';
    const warmOut = '$ node scripts/warm-cache.js --top 500\nwarmed 500 keys in 12.4s';
    const janitorFail =
      'pruning volumes older than 90d\nERROR: lock held by janitor-7f2c (another run?)\nexit status 1';

    const runs: JobRunView[] = [
      run('job-cache-warmup', 0.4 * HOUR, 'succeeded', 1, 0, 13_000, warmOut),
      run('job-cache-warmup', 1.4 * HOUR, 'succeeded', 1, 0, 12_000, warmOut),
      run('job-nightly-report', 10 * HOUR, 'succeeded', 1, 0, 39_000, reportOut),
      run('job-cache-warmup', 2.4 * HOUR, 'succeeded', 1, 0, 14_000, warmOut),
      run('job-nightly-report', 34 * HOUR, 'succeeded', 1, 0, 41_000, reportOut),
      // Monday 03:00 cleanup: first attempt failed, retry failed too → alert fired.
      run('job-weekly-cleanup', 3 * DAY - 6 * MIN, 'failed', 2, 1, 22_000, janitorFail),
      run('job-weekly-cleanup', 3 * DAY, 'failed', 1, 1, 25_000, janitorFail),
      run('job-nightly-report', 58 * HOUR, 'timeout', 1, null, 900_000, 'rendering 42 pages\n[killed at 15m timeout]'),
      run('job-nightly-report', 58 * HOUR - 16 * MIN, 'succeeded', 2, 0, 40_000, reportOut),
      run('job-weekly-cleanup', 10 * DAY, 'succeeded', 1, 0, 310_000, 'pruned 18 volumes, 42 GB reclaimed'),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    store.extra.jobs = { jobs, runs } satisfies JobsState;
  },
};
