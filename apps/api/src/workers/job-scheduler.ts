import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext, writeAudit } from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import type { RunOnceResult } from '@swarmy/core/protocol';
import { hub } from '../gateway';

/**
 * Scheduled-job worker (slice B2). Every 30s: fire every due, enabled
 * `ScheduledJob` — due = the next cron occurrence after `lastRunAt` (or
 * `createdAt` when never run) has passed. `lastRunAt` is advanced BEFORE
 * executing (backup-scheduler precedent) so overlapping ticks never
 * double-fire; execution runs detached with one `JobRun` row per attempt,
 * retry backoff, and a `job-failed` alert event when the final attempt fails
 * and the job asks for it.
 *
 * Kind `image` → `container.runOnce` on a node picked from the `runOnJson`
 * constraints (pin > label match > any online worker > any online node); kind
 * `service-exec` → `exec` in a running task container of the target service.
 *
 * The cron evaluator + due rule + execution mirror `@swarmy/trpc`
 * jobs.service.ts / schedule.ts (the unit-tested canonical copies) — a worker
 * cannot subpath-import an internal trpc module, the same constraint the
 * backup-scheduler and manageddb-reconcile workers document. Collapse this
 * file to `runDueScheduledJobs(now, deps)` once that seam is re-exported from
 * the `@swarmy/trpc` package root.
 */

const TICK_MS = 30_000;
const DISPATCH_MARGIN_MS = 30_000;
const OUTPUT_TAIL_CHARS = 65_536;

// ── cron mirror (canonical: @swarmy/trpc schedule.ts, UTC, vixie 5-field) ────

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (!part) throw new Error(`invalid cron field "${field}"`);
    const [rangePart = '', stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1 || (stepPart !== undefined && !/^\d+$/.test(stepPart))) {
      throw new Error(`invalid cron step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (!a || !b || !/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new Error(`invalid cron range "${part}"`);
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      if (!/^\d+$/.test(rangePart)) throw new Error(`invalid cron value "${part}"`);
      lo = Number.parseInt(rangePart, 10);
      hi = stepPart === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty cron field "${field}"`);
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron "${expr}" must have exactly 5 fields`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseField(dow, 0, 7);
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseField(m, 0, 59),
    hours: parseField(h, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

function cronMatches(spec: CronSpec, at: Date): boolean {
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
const CRON_SCAN_LIMIT = 366 * 24 * 60;

/** First occurrence strictly AFTER `from`, or null within a year. */
export function cronNext(spec: CronSpec, from: Date): Date | null {
  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < CRON_SCAN_LIMIT; i++, t += MINUTE_MS) {
    if (cronMatches(spec, new Date(t))) return new Date(t);
  }
  return null;
}

// ── pure due selection (mirror of jobs.service `isJobDue`; unit-tested) ─────

export interface DueCandidate {
  id: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
}

/** Ids of the jobs whose next occurrence after their last fire has passed. */
export function selectDueJobs(jobs: readonly DueCandidate[], now: Date): string[] {
  const due: string[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    let spec: CronSpec;
    try {
      spec = parseCron(job.schedule);
    } catch {
      continue; // unparseable cron surfaces as nextRunAt=null in the UI
    }
    const next = cronNext(spec, job.lastRunAt ?? job.createdAt);
    if (next && next.getTime() <= now.getTime()) due.push(job.id);
  }
  return due;
}

/** Retry backoff: 5s, 10s, 20s, … capped at 60s (attempt is 1-based). */
export function retryBackoffMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

// ── execution (mirror of jobs.service executeAttempts) ──────────────────────

type JobRow = Awaited<ReturnType<typeof prisma.scheduledJob.findMany>>[number];

interface AttemptOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';
  exitCode: number | null;
  output: string;
}

const strings = (json: unknown): string[] =>
  Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : [];

const record = (json: unknown): Record<string, string> => {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pin > label match > any online worker > any online node. Null when nothing fits. */
async function pickJobNode(orgId: string, runOnJson: unknown): Promise<string | null> {
  const runOn = (runOnJson ?? {}) as { nodeId?: unknown; labels?: unknown };
  const rows = await prisma.node.findMany({ where: { orgId }, select: { id: true, name: true } });
  const online = rows.filter((r) => hub.isOnline(r.id));
  if (typeof runOn.nodeId === 'string' && runOn.nodeId.length > 0) {
    return online.find((r) => r.id === runOn.nodeId || r.name === runOn.nodeId)?.id ?? null;
  }
  const want = record(runOn.labels);
  const candidates =
    Object.keys(want).length > 0
      ? online.filter((r) => {
          const labels = hub.nodeInfoFor(r.id)?.labels;
          return Object.entries(want).every(([k, v]) => labels?.[k] === v);
        })
      : online;
  if (candidates.length === 0) return null;
  const worker = candidates.find((r) => hub.nodeInfoFor(r.id)?.role === 'worker');
  return (worker ?? candidates[0]!).id;
}

/** A running task container of the service (by Docker id or name) + its node. */
function findExecTarget(orgId: string, serviceRef: string): { containerId: string; nodeId: string } | null {
  const { services, containers } = hub.liveInventory(orgId);
  const svc = services.find((s) => s.id === serviceRef) ?? services.find((s) => s.name === serviceRef);
  if (!svc) return null;
  const orgContainerIds = new Set(containers.map((c) => c.id));
  for (const nodeId of hub.onlineNodeIds()) {
    const match = hub.latestContainers(nodeId).find((c) => {
      if (!orgContainerIds.has(c.id)) return false;
      const sid = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
      return sid === svc.id && c.state === 'running';
    });
    if (match) return { containerId: match.id, nodeId };
  }
  return null;
}

async function performAttempt(job: JobRow): Promise<AttemptOutcome> {
  const command = strings(job.command);
  try {
    if (job.kind === 'IMAGE') {
      const nodeId = await pickJobNode(job.orgId, job.runOnJson);
      if (!nodeId) return { status: 'FAILED', exitCode: null, output: 'no online node matches the job’s placement' };
      const res = await hub.dispatch<RunOnceResult>(
        nodeId,
        'container.runOnce',
        { image: job.image, cmd: command, env: record(job.envJson), timeoutMs: job.timeoutMs },
        { timeoutMs: job.timeoutMs + DISPATCH_MARGIN_MS },
      );
      if (res.timedOut) return { status: 'TIMEOUT', exitCode: res.exitCode ?? null, output: res.output };
      return { status: res.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode: res.exitCode, output: res.output };
    }
    const target = findExecTarget(job.orgId, job.serviceRef ?? '');
    if (!target) {
      return { status: 'FAILED', exitCode: null, output: `no running container found for service "${job.serviceRef}"` };
    }
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      { target: { containerId: target.containerId }, cmd: command, tty: false, stream: false, timeoutMs: job.timeoutMs },
      { timeoutMs: job.timeoutMs + DISPATCH_MARGIN_MS },
    );
    return { status: res.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode: res.exitCode, output: res.output ?? '' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { status: /time.?out/i.test(message) ? 'TIMEOUT' : 'FAILED', exitCode: null, output: message };
  }
}

/** One `JobRun` row per attempt; a cancelled row (no longer RUNNING) stops the chain. */
async function executeJob(ctx: OrgContext, job: JobRow): Promise<void> {
  const budget = 1 + Math.max(0, job.retries);
  let final: AttemptOutcome | null = null;
  for (let attempt = 1; attempt <= budget; attempt++) {
    const run = await prisma.jobRun.create({
      data: { orgId: job.orgId, jobId: job.id, status: 'RUNNING', attempt },
      select: { id: true },
    });
    const outcome = await performAttempt(job);
    const updated = await prisma.jobRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: {
        status: outcome.status,
        exitCode: outcome.exitCode,
        outputTail: outcome.output.slice(-OUTPUT_TAIL_CHARS),
        finishedAt: new Date(),
      },
    });
    if (updated.count === 0) return; // cancelled by the user — stop retrying
    final = outcome;
    if (outcome.status === 'SUCCEEDED') break;
    if (attempt < budget) await sleep(retryBackoffMs(attempt));
  }
  if (final && final.status !== 'SUCCEEDED' && job.alertOnFailure) {
    await fireEvent(ctx, {
      signal: 'job-failed',
      severity: 'warning',
      resource: `job/${job.name}`,
      message: `Scheduled job "${job.name}" ${final.status === 'TIMEOUT' ? 'timed out' : 'failed'}${
        final.exitCode != null ? ` (exit ${final.exitCode})` : ''
      } after ${budget} attempt${budget === 1 ? '' : 's'}`,
    }).catch(() => undefined);
  }
}

// ── tick ─────────────────────────────────────────────────────────────────────

async function tick(now: Date): Promise<void> {
  const jobs = await prisma.scheduledJob.findMany({ where: { enabled: true } });
  const due = new Set(selectDueJobs(jobs, now));
  if (due.size === 0) return;
  const auth = authRegistry.getAuth();
  for (const job of jobs) {
    if (!due.has(job.id)) continue;
    // Advance first so a slow run (or overlapping tick) never double-fires.
    await prisma.scheduledJob.update({ where: { id: job.id }, data: { lastRunAt: now } });
    const ctx = systemContext({ db: prisma, hub, auth }, job.orgId);
    await writeAudit(ctx, {
      action: 'job.fire',
      actorType: 'system',
      targetType: 'scheduledJob',
      targetId: job.id,
      metadata: { name: job.name, schedule: job.schedule },
    });
    // Detached: a 10-minute container must not block the scheduler tick.
    void executeJob(ctx, job).catch(() => undefined);
  }
}

export function startJobScheduler(): () => void {
  const timer = setInterval(() => {
    tick(new Date()).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
