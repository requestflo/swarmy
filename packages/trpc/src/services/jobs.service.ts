import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type {
  CreateScheduledJobInput,
  JobKind,
  JobRunOnView,
  JobRunStatusView,
  JobRunView,
  JobRunsInput,
  JobRunsPage,
  JobsOverview,
  SchedulePreview,
  ScheduledJobView,
  UpdateScheduledJobInput,
} from '@swarmy/core';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, notFound } from '../errors';
import { fireEvent } from './alerts-fire';
import { writeAudit } from './audit.service';
import { systemContext } from './cicd.service';
import { resolveExecTarget } from './live-resolve';
import { cronNext, cronNextN, describeCron, isJobDue, parseCron, type CronSpec } from './schedule';

/**
 * Scheduled jobs (slice B2) — user cron that fires one-shot containers
 * (`container.runOnce`) or execs into a running service task (`exec`).
 *
 * Storage split (docker-native-storage): `ScheduledJob` is the user's INPUT
 * artifact (like `Stack.composeSource`) and `JobRun` is queryable run HISTORY —
 * both legitimately Postgres. Nothing about live swarm state is persisted; the
 * execution target is resolved from the live inventory at fire time.
 *
 * The job-scheduler worker (apps/api) mirrors the due rule + execution of this
 * canonical, unit-tested copy (a worker cannot subpath-import an internal trpc
 * module); `runDueScheduledJobs` is the seam the worker collapses to once it is
 * re-exported from the package root.
 */

// ── pure: config validation + JSON codecs (unit-tested) ─────────────────────

export interface JobConfigFields {
  kind: JobKind;
  schedule: string;
  image?: string | null;
  serviceRef?: string | null;
  command: string[];
  env: Record<string, string>;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a job's config; returns a human problem list (empty = valid). */
export function validateJobConfig(fields: JobConfigFields): string[] {
  const problems: string[] = [];
  try {
    parseCron(fields.schedule);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : 'invalid cron expression');
  }
  if (fields.command.length === 0) problems.push('a command is required');
  if (fields.kind === 'image' && !fields.image?.trim()) {
    problems.push('image jobs need an image');
  }
  if (fields.kind === 'service-exec' && !fields.serviceRef?.trim()) {
    problems.push('service-exec jobs need a target service');
  }
  for (const key of Object.keys(fields.env)) {
    if (!ENV_KEY_RE.test(key)) problems.push(`invalid env var name "${key}"`);
  }
  return problems;
}

/** `command` Json column → string[] (defensive against hand-edited rows). */
export function parseCommand(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : [];
}

/** `envJson` Json column → env record (string values only). */
export function parseEnv(json: unknown): Record<string, string> {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** `runOnJson` Json column → placement constraints view. */
export function parseRunOn(json: unknown): JobRunOnView {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  const v = json as { nodeId?: unknown; labels?: unknown };
  const out: JobRunOnView = {};
  if (typeof v.nodeId === 'string' && v.nodeId.length > 0) out.nodeId = v.nodeId;
  if (v.labels && typeof v.labels === 'object' && !Array.isArray(v.labels)) {
    const labels: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.labels as Record<string, unknown>)) {
      if (typeof val === 'string') labels[k] = val;
    }
    if (Object.keys(labels).length > 0) out.labels = labels;
  }
  return out;
}

/** All `want` labels present with equal values on the node. */
export function matchesNodeLabels(
  nodeLabels: Record<string, string> | undefined,
  want: Record<string, string>,
): boolean {
  return Object.entries(want).every(([k, v]) => nodeLabels?.[k] === v);
}

/** Retry backoff: 5s, 10s, 20s, … capped at 60s (attempt is 1-based). */
export function retryBackoffMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

export interface AttemptOutcome {
  status: Exclude<JobRunStatusView, 'running'>;
  exitCode: number | null;
  output: string;
}

/** Map a `container.runOnce` result to a run outcome. */
export function outcomeFromRunOnce(res: Pick<RunOnceResult, 'exitCode' | 'output' | 'timedOut'>): AttemptOutcome {
  if (res.timedOut) return { status: 'timeout', exitCode: res.exitCode ?? null, output: res.output };
  return {
    status: res.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: res.exitCode,
    output: res.output,
  };
}

/** Map a thrown dispatch error to a run outcome (timeout-aware). */
export function outcomeFromError(e: unknown): AttemptOutcome {
  const message = e instanceof Error ? e.message : String(e);
  return {
    status: /time.?out/i.test(message) ? 'timeout' : 'failed',
    exitCode: null,
    output: message,
  };
}

// ── row ↔ view mapping ───────────────────────────────────────────────────────

const KIND_TO_VIEW: Record<string, JobKind> = { IMAGE: 'image', SERVICE_EXEC: 'service-exec' };
const KIND_TO_DB: Record<JobKind, 'IMAGE' | 'SERVICE_EXEC'> = {
  image: 'IMAGE',
  'service-exec': 'SERVICE_EXEC',
};
const RUN_STATUS_TO_VIEW: Record<string, JobRunStatusView> = {
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
};
const RUN_STATUS_TO_DB: Record<Exclude<JobRunStatusView, 'running'>, 'SUCCEEDED' | 'FAILED' | 'TIMEOUT'> = {
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  timeout: 'TIMEOUT',
};

interface JobRow {
  id: string;
  orgId: string;
  name: string;
  stackName: string | null;
  schedule: string;
  kind: string;
  image: string | null;
  serviceRef: string | null;
  command: unknown;
  envJson: unknown;
  runOnJson: unknown;
  timeoutMs: number;
  retries: number;
  alertOnFailure: boolean;
  enabled: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
}

/** `ScheduledJobView` + the stack-scoped IA field (local until core absorbs it). */
export type ScheduledJobFullView = ScheduledJobView & { stackName: string | null };

interface RunRow {
  id: string;
  jobId: string;
  status: string;
  exitCode: number | null;
  outputTail: string | null;
  attempt: number;
  startedAt: Date;
  finishedAt: Date | null;
}

function runToView(row: RunRow): JobRunView {
  return {
    id: row.id,
    jobId: row.jobId,
    status: RUN_STATUS_TO_VIEW[row.status] ?? 'running',
    exitCode: row.exitCode,
    outputTail: row.outputTail,
    attempt: row.attempt,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Next occurrence for display: after now, independent of run history. */
function nextRunAtOf(row: Pick<JobRow, 'schedule' | 'enabled'>, now: Date): Date | null {
  if (!row.enabled) return null;
  try {
    return cronNext(parseCron(row.schedule), now);
  } catch {
    return null;
  }
}

function toView(row: JobRow, lastRunStatus: JobRunStatusView | null, now: Date): ScheduledJobFullView {
  return {
    id: row.id,
    name: row.name,
    stackName: row.stackName,
    schedule: row.schedule,
    scheduleText: describeCron(row.schedule),
    kind: KIND_TO_VIEW[row.kind] ?? 'image',
    image: row.image,
    serviceRef: row.serviceRef,
    command: parseCommand(row.command),
    env: parseEnv(row.envJson),
    runOn: parseRunOn(row.runOnJson),
    timeoutMs: row.timeoutMs,
    retries: row.retries,
    alertOnFailure: row.alertOnFailure,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus,
    nextRunAt: nextRunAtOf(row, now)?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireJob(ctx: OrgContext, id: string): Promise<JobRow> {
  const row = await ctx.db.scheduledJob.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('job', id);
  return row;
}

async function latestRunStatus(ctx: OrgContext, jobId: string): Promise<JobRunStatusView | null> {
  const run = await ctx.db.jobRun.findFirst({
    where: { orgId: ctx.activeOrgId, jobId },
    orderBy: { startedAt: 'desc' },
    select: { status: true },
  });
  return run ? (RUN_STATUS_TO_VIEW[run.status] ?? 'running') : null;
}

// ── queries ──────────────────────────────────────────────────────────────────

export async function overview(ctx: OrgContext, stack?: string): Promise<JobsOverview> {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const [jobs, recent] = await Promise.all([
    ctx.db.scheduledJob.findMany({
      where: { orgId: ctx.activeOrgId, ...(stack ? { stackName: stack } : {}) },
    }),
    ctx.db.jobRun.findMany({
      where: {
        orgId: ctx.activeOrgId,
        startedAt: { gte: since },
        ...(stack ? { job: { stackName: stack } } : {}),
      },
      select: { status: true },
    }),
  ]);
  let nextRunAt: Date | null = null;
  let nextJobName: string | null = null;
  for (const job of jobs) {
    const next = nextRunAtOf(job, now);
    if (next && (!nextRunAt || next < nextRunAt)) {
      nextRunAt = next;
      nextJobName = job.name;
    }
  }
  return {
    total: jobs.length,
    enabled: jobs.filter((j) => j.enabled).length,
    succeeded24h: recent.filter((r) => r.status === 'SUCCEEDED').length,
    failed24h: recent.filter((r) => r.status === 'FAILED' || r.status === 'TIMEOUT').length,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    nextJobName,
  };
}

export async function listJobs(ctx: OrgContext, stack?: string): Promise<ScheduledJobFullView[]> {
  const now = new Date();
  const rows = await ctx.db.scheduledJob.findMany({
    where: { orgId: ctx.activeOrgId, ...(stack ? { stackName: stack } : {}) },
    orderBy: { name: 'asc' },
  });
  // Latest run per job in one query (newest-first + distinct on jobId).
  const latest = await ctx.db.jobRun.findMany({
    where: { orgId: ctx.activeOrgId, jobId: { in: rows.map((r) => r.id) } },
    orderBy: { startedAt: 'desc' },
    distinct: ['jobId'],
    select: { jobId: true, status: true },
  });
  const statusByJob = new Map(latest.map((r) => [r.jobId, RUN_STATUS_TO_VIEW[r.status] ?? 'running']));
  return rows.map((row) => toView(row, statusByJob.get(row.id) ?? null, now));
}

export async function listRuns(ctx: OrgContext, input: JobRunsInput): Promise<JobRunsPage> {
  await requireJob(ctx, input.jobId); // 404 for foreign/unknown jobs
  const rows = await ctx.db.jobRun.findMany({
    where: { orgId: ctx.activeOrgId, jobId: input.jobId },
    orderBy: { startedAt: 'desc' },
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, input.limit);
  return {
    runs: page.map(runToView),
    nextCursor: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Validate + describe a cron and return its next occurrences (schedule editor). */
export function previewSchedule(input: { schedule: string; count: number }, from = new Date()): SchedulePreview {
  let spec: CronSpec;
  try {
    spec = parseCron(input.schedule);
  } catch (e) {
    return {
      valid: false,
      scheduleText: input.schedule.trim(),
      next: [],
      error: e instanceof Error ? e.message : 'invalid cron expression',
    };
  }
  return {
    valid: true,
    scheduleText: describeCron(input.schedule),
    next: cronNextN(spec, from, input.count).map((d) => d.toISOString()),
    error: null,
  };
}

// ── mutations ────────────────────────────────────────────────────────────────

function assertValidConfig(fields: JobConfigFields): void {
  const problems = validateJobConfig(fields);
  if (problems.length > 0) throw commandRejected(problems.join('; '));
}

export async function createJob(
  ctx: OrgContext,
  input: CreateScheduledJobInput & { stackName?: string },
): Promise<ScheduledJobFullView> {
  assertValidConfig(input);
  const existing = await ctx.db.scheduledJob.findFirst({
    where: { orgId: ctx.activeOrgId, name: input.name },
    select: { id: true },
  });
  if (existing) throw commandRejected(`a job named "${input.name}" already exists`);

  const row = await ctx.db.scheduledJob.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      stackName: input.stackName ?? null,
      schedule: input.schedule,
      kind: KIND_TO_DB[input.kind],
      image: input.kind === 'image' ? (input.image ?? null) : null,
      serviceRef: input.kind === 'service-exec' ? (input.serviceRef ?? null) : null,
      command: input.command,
      envJson: input.env,
      runOnJson: input.runOn as object,
      timeoutMs: input.timeoutMs,
      retries: input.retries,
      alertOnFailure: input.alertOnFailure,
      enabled: input.enabled,
    },
  });
  await writeAudit(ctx, {
    action: 'job.create',
    targetType: 'scheduledJob',
    targetId: row.id,
    metadata: {
      name: input.name,
      schedule: input.schedule,
      kind: input.kind,
      ...(input.stackName ? { stackName: input.stackName } : {}),
    },
  });
  return toView(row, null, new Date());
}

export async function updateJob(
  ctx: OrgContext,
  input: UpdateScheduledJobInput & { stackName?: string },
): Promise<ScheduledJobFullView> {
  const row = await requireJob(ctx, input.id);
  const kind = input.kind ?? (KIND_TO_VIEW[row.kind] ?? 'image');
  assertValidConfig({
    kind,
    schedule: input.schedule ?? row.schedule,
    image: input.image ?? row.image,
    serviceRef: input.serviceRef ?? row.serviceRef,
    command: input.command ?? parseCommand(row.command),
    env: input.env ?? parseEnv(row.envJson),
  });
  if (input.name && input.name !== row.name) {
    const clash = await ctx.db.scheduledJob.findFirst({
      where: { orgId: ctx.activeOrgId, name: input.name, id: { not: row.id } },
      select: { id: true },
    });
    if (clash) throw commandRejected(`a job named "${input.name}" already exists`);
  }

  const updated = await ctx.db.scheduledJob.update({
    where: { id: row.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.stackName !== undefined ? { stackName: input.stackName } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.kind !== undefined ? { kind: KIND_TO_DB[input.kind] } : {}),
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.serviceRef !== undefined ? { serviceRef: input.serviceRef } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.env !== undefined ? { envJson: input.env } : {}),
      ...(input.runOn !== undefined ? { runOnJson: input.runOn as object } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
      ...(input.alertOnFailure !== undefined ? { alertOnFailure: input.alertOnFailure } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'job.update',
    targetType: 'scheduledJob',
    targetId: row.id,
    metadata: { name: updated.name, schedule: updated.schedule },
  });
  return toView(updated, await latestRunStatus(ctx, row.id), new Date());
}

export async function removeJob(ctx: OrgContext, id: string): Promise<{ id: string }> {
  const row = await requireJob(ctx, id);
  await ctx.db.scheduledJob.delete({ where: { id: row.id } });
  await writeAudit(ctx, {
    action: 'job.remove',
    targetType: 'scheduledJob',
    targetId: row.id,
    metadata: { name: row.name },
  });
  return { id: row.id };
}

export async function toggleJob(ctx: OrgContext, input: { id: string; enabled: boolean }): Promise<ScheduledJobView> {
  const row = await requireJob(ctx, input.id);
  const updated = await ctx.db.scheduledJob.update({
    where: { id: row.id },
    data: { enabled: input.enabled },
  });
  await writeAudit(ctx, {
    action: 'job.toggle',
    targetType: 'scheduledJob',
    targetId: row.id,
    metadata: { name: row.name, enabled: input.enabled },
  });
  return toView(updated, await latestRunStatus(ctx, row.id), new Date());
}

/**
 * Best-effort cancel of a RUNNING run: flips it to `failed` so the executor's
 * completion write (guarded `status: RUNNING`) becomes a no-op and retries stop.
 * The in-flight container is not chased down — the agent kills it at
 * `timeoutMs` anyway (documented best-effort).
 */
export async function cancelRun(ctx: OrgContext, runId: string): Promise<JobRunView> {
  const run = await ctx.db.jobRun.findFirst({ where: { id: runId, orgId: ctx.activeOrgId } });
  if (!run) throw notFound('job run', runId);
  await ctx.db.jobRun.updateMany({
    where: { id: runId, orgId: ctx.activeOrgId, status: 'RUNNING' },
    data: { status: 'FAILED', finishedAt: new Date(), outputTail: '[cancelled by user]' },
  });
  await writeAudit(ctx, {
    action: 'job.cancelRun',
    targetType: 'jobRun',
    targetId: runId,
    metadata: { jobId: run.jobId },
  });
  const fresh = await ctx.db.jobRun.findFirst({ where: { id: runId, orgId: ctx.activeOrgId } });
  return runToView(fresh ?? run);
}

/**
 * Fire a job immediately. Stamps `lastRunAt` (a manual run IS the last run —
 * under the due rule this never skips a pending slot that already passed) and
 * executes in the background; the UI polls `runs` for the outcome.
 */
export async function runNow(ctx: OrgContext, id: string): Promise<{ jobId: string; runId: string }> {
  const row = await requireJob(ctx, id);
  assertValidConfig({
    kind: KIND_TO_VIEW[row.kind] ?? 'image',
    schedule: row.schedule,
    image: row.image,
    serviceRef: row.serviceRef,
    command: parseCommand(row.command),
    env: parseEnv(row.envJson),
  });
  await ctx.db.scheduledJob.update({ where: { id: row.id }, data: { lastRunAt: new Date() } });
  const runId = await startJobExecution(ctx, row);
  await writeAudit(ctx, {
    action: 'job.runNow',
    targetType: 'scheduledJob',
    targetId: row.id,
    metadata: { name: row.name, runId },
  });
  return { jobId: row.id, runId };
}

// ── execution (shared by runNow and the scheduler seam) ──────────────────────

const DISPATCH_MARGIN_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pick the node an `image` job runs on: pin > label match > any online worker > any online. */
async function pickJobNode(ctx: OrgContext, runOn: JobRunOnView): Promise<string> {
  const rows = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const online = rows.filter((r) => ctx.hub.isOnline(r.id));
  if (runOn.nodeId) {
    const pinned = online.find((r) => r.id === runOn.nodeId || r.name === runOn.nodeId);
    if (!pinned) throw commandRejected(`requested node "${runOn.nodeId}" is not online`);
    return pinned.id;
  }
  const candidates = runOn.labels
    ? online.filter((r) => matchesNodeLabels(ctx.hub.nodeInfoFor(r.id)?.labels, runOn.labels ?? {}))
    : online;
  if (candidates.length === 0) {
    throw commandRejected(
      runOn.labels ? 'no online node matches the job’s placement labels' : 'no online node to run the job',
    );
  }
  const worker = candidates.find((r) => ctx.hub.nodeInfoFor(r.id)?.role === 'worker');
  return (worker ?? candidates[0]!).id;
}

/** One attempt: dispatch runOnce/exec and normalize the outcome (never throws). */
async function performAttempt(ctx: OrgContext, job: JobRow): Promise<AttemptOutcome> {
  const command = parseCommand(job.command);
  try {
    if ((KIND_TO_VIEW[job.kind] ?? 'image') === 'image') {
      const nodeId = await pickJobNode(ctx, parseRunOn(job.runOnJson));
      const res = await ctx.hub.dispatch<RunOnceResult>(
        nodeId,
        'container.runOnce',
        {
          image: job.image,
          cmd: command,
          env: parseEnv(job.envJson),
          timeoutMs: job.timeoutMs,
        },
        { timeoutMs: job.timeoutMs + DISPATCH_MARGIN_MS },
      );
      return outcomeFromRunOnce(res);
    }
    const target = resolveExecTarget(ctx, job.serviceRef ?? '');
    if (!target) {
      return {
        status: 'failed',
        exitCode: null,
        output: `no running container found for service "${job.serviceRef}"`,
      };
    }
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: command,
        tty: false,
        stream: false,
        timeoutMs: job.timeoutMs,
      },
      { timeoutMs: job.timeoutMs + DISPATCH_MARGIN_MS },
    );
    return {
      status: res.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: res.exitCode,
      output: res.output ?? '',
    };
  } catch (e) {
    return outcomeFromError(e);
  }
}

/**
 * Run a job's attempt chain in the background: one `JobRun` row per attempt,
 * retry with backoff until success or the budget (`1 + retries`) is spent, and
 * raise a `job-failed` alert event when the final attempt fails and the job
 * asks for it. Returns the FIRST attempt's run id immediately.
 */
async function startJobExecution(ctx: OrgContext, job: JobRow): Promise<string> {
  const first = await ctx.db.jobRun.create({
    data: { orgId: ctx.activeOrgId, jobId: job.id, status: 'RUNNING', attempt: 1 },
    select: { id: true },
  });
  void executeAttempts(ctx, job, first.id).catch(() => undefined);
  return first.id;
}

async function executeAttempts(ctx: OrgContext, job: JobRow, firstRunId: string): Promise<void> {
  const budget = 1 + Math.max(0, job.retries);
  let final: AttemptOutcome | null = null;
  for (let attempt = 1; attempt <= budget; attempt++) {
    const runId =
      attempt === 1
        ? firstRunId
        : (
            await ctx.db.jobRun.create({
              data: { orgId: ctx.activeOrgId, jobId: job.id, status: 'RUNNING', attempt },
              select: { id: true },
            })
          ).id;
    const outcome = await performAttempt(ctx, job);
    // Guarded completion write: cancelRun may have flipped the row already.
    const updated = await ctx.db.jobRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: RUN_STATUS_TO_DB[outcome.status],
        exitCode: outcome.exitCode,
        outputTail: outcome.output.slice(-65_536),
        finishedAt: new Date(),
      },
    });
    if (updated.count === 0) return; // cancelled — stop retrying
    final = outcome;
    if (outcome.status === 'succeeded') break;
    if (attempt < budget) await sleep(retryBackoffMs(attempt));
  }
  if (final && final.status !== 'succeeded' && job.alertOnFailure) {
    await fireEvent(ctx, {
      signal: 'job-failed',
      severity: 'warning',
      resource: `job/${job.name}`,
      message: `Scheduled job "${job.name}" ${final.status === 'timeout' ? 'timed out' : 'failed'}${
        final.exitCode != null ? ` (exit ${final.exitCode})` : ''
      } after ${budget} attempt${budget === 1 ? '' : 's'}`,
    }).catch(() => undefined);
  }
}

// ── scheduler tick seam (mirrored by apps/api workers/job-scheduler.ts) ──────

export interface RunDueJobsDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/**
 * Fire every due, enabled job across all orgs: due = the next cron occurrence
 * after `lastRunAt` (or `createdAt` when never run) has passed. `lastRunAt` is
 * advanced BEFORE executing so an overlapping tick never double-fires
 * (backup-scheduler precedent); execution itself runs detached. Without `deps`
 * there is nothing to scan with, so it no-ops (spine-era call shape).
 */
export async function runDueScheduledJobs(now: Date, deps?: RunDueJobsDeps): Promise<void> {
  if (!deps) return;
  const jobs = await deps.db.scheduledJob.findMany({ where: { enabled: true } });
  for (const job of jobs) {
    let spec: CronSpec;
    try {
      spec = parseCron(job.schedule);
    } catch {
      continue; // unparseable cron surfaces as nextRunAt=null in the UI
    }
    if (!isJobDue(spec, job.lastRunAt, job.createdAt, now)) continue;
    const ctx = systemContext(deps, job.orgId);
    await deps.db.scheduledJob.update({ where: { id: job.id }, data: { lastRunAt: now } });
    const runId = await startJobExecution(ctx, job);
    await writeAudit(ctx, {
      action: 'job.fire',
      actorType: 'system',
      targetType: 'scheduledJob',
      targetId: job.id,
      metadata: { name: job.name, schedule: job.schedule, runId },
    });
  }
}
