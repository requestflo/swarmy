import type {
  CreateWorkflowDefInput,
  TriggerWorkflowInput,
  UpdateWorkflowDefInput,
  WorkflowDecisionInput,
  WorkflowDefVersionView,
  WorkflowDefView,
  WorkflowRunDetailView,
  WorkflowRunState,
  WorkflowRunStatusView,
  WorkflowRunView,
  WorkflowRunsInput,
  WorkflowRunsPage,
  WorkflowStepDef,
  WorkflowStepInput,
  WorkflowStepKind,
  WorkflowStepRunView,
  WorkflowStepStatusView,
  WorkflowStepView,
  WorkflowsOverview,
} from '@swarmy/core';
import { WORKFLOW_STEP_KINDS } from '@swarmy/core';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';

/**
 * Workflow engine (slice B3) — versioned sequential step definitions, durable
 * runs, approvals. Storage split (docker-native-storage): `WorkflowDef` is the
 * user's INPUT artifact (like `Stack.composeSource`) and `WorkflowRun` /
 * `WorkflowStepRun` are queryable run HISTORY — legitimately Postgres. Nothing
 * about live swarm state is persisted; step targets are resolved from the live
 * inventory at execution time by the workflow-runner worker (apps/api), which
 * owns the unit-tested `advanceState` reducer this service's approve/reject
 * transitions deliberately mirror (a worker cannot subpath-import an internal
 * trpc module — the job-scheduler precedent).
 *
 * Webhook step HMAC secrets are vault-encrypted (`config.secretEnc`) before the
 * steps ever reach `stepsJson`; plaintext is never persisted or returned.
 */

const OUTPUT_PRETTY_LIMIT = 8_192;

// ── pure: steps codec + validation (unit-tested) ─────────────────────────────

const KIND_SET = new Set<string>(WORKFLOW_STEP_KINDS);

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

/** `stepsJson` Json column → step defs (defensive against hand-edited rows). */
export function parseSteps(json: unknown): WorkflowStepDef[] {
  if (!Array.isArray(json)) return [];
  const out: WorkflowStepDef[] = [];
  for (const raw of json) {
    if (raw === null || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.name !== 'string' || typeof v.kind !== 'string' || !KIND_SET.has(v.kind)) continue;
    const c = (v.config && typeof v.config === 'object' && !Array.isArray(v.config) ? v.config : {}) as Record<
      string,
      unknown
    >;
    out.push({
      name: v.name,
      kind: v.kind as WorkflowStepKind,
      config: {
        ...(typeof c.image === 'string' ? { image: c.image } : {}),
        ...(Array.isArray(c.command) ? { command: strings(c.command) } : {}),
        ...(c.env !== undefined ? { env: record(c.env) } : {}),
        ...(typeof c.serviceRef === 'string' ? { serviceRef: c.serviceRef } : {}),
        ...(typeof c.url === 'string' ? { url: c.url } : {}),
        ...(typeof c.secretEnc === 'string' ? { secretEnc: c.secretEnc } : {}),
        ...(typeof c.prompt === 'string' ? { prompt: c.prompt } : {}),
        ...(typeof c.seconds === 'number' ? { seconds: c.seconds } : {}),
      },
      ...(typeof v.timeoutMs === 'number' ? { timeoutMs: v.timeoutMs } : {}),
      ...(typeof v.retries === 'number' ? { retries: v.retries } : {}),
    });
  }
  return out;
}

/** `stateJson` Json column → run state (defensive). */
export function parseRunState(json: unknown): WorkflowRunState {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { input: null, steps: [] };
  const v = json as Record<string, unknown>;
  const steps = Array.isArray(v.steps)
    ? v.steps
        .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
        .map((s) => ({
          name: typeof s.name === 'string' ? s.name : '',
          ...(s.output !== undefined ? { output: s.output } : {}),
          ...(typeof s.error === 'string' ? { error: s.error } : {}),
        }))
    : [];
  return {
    input: v.input ?? null,
    steps,
    ...(typeof v.nextEligibleAt === 'string' ? { nextEligibleAt: v.nextEligibleAt } : {}),
  };
}

const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/** Validate submitted steps; returns a human problem list (empty = valid). */
export function validateSteps(steps: WorkflowStepInput[]): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push('a workflow needs at least one step');
  const seen = new Set<string>();
  for (const step of steps) {
    const at = `step "${step.name}"`;
    if (seen.has(step.name)) problems.push(`duplicate step name "${step.name}"`);
    seen.add(step.name);
    const c = step.config;
    switch (step.kind) {
      case 'container':
        if (!c.image?.trim()) problems.push(`${at}: container steps need an image`);
        break;
      case 'service-exec':
        if (!c.serviceRef?.trim()) problems.push(`${at}: service-exec steps need a target service`);
        if (!c.command || c.command.length === 0) problems.push(`${at}: service-exec steps need a command`);
        break;
      case 'webhook':
        if (!c.url?.trim() || !HTTP_URL_RE.test(c.url.trim())) {
          problems.push(`${at}: webhook steps need an http(s) URL`);
        }
        break;
      case 'delay':
        if (!c.seconds || c.seconds < 1) problems.push(`${at}: delay steps need seconds ≥ 1`);
        break;
      case 'approval':
        break;
    }
  }
  return problems;
}

/**
 * Submitted steps → stored steps: encrypt webhook secrets; when a secret is
 * omitted on edit, carry the previous version's stored secret for the
 * same-named webhook step forward (values are write-only, so the builder
 * cannot round-trip them).
 */
export function toStoredSteps(
  steps: WorkflowStepInput[],
  previous: WorkflowStepDef[] = [],
  encrypt: (plain: string) => string = encryptSecret,
): WorkflowStepDef[] {
  return steps.map((step) => {
    const { secret, ...config } = step.config;
    const carried =
      step.kind === 'webhook' && !secret
        ? previous.find((p) => p.kind === 'webhook' && p.name === step.name)?.config.secretEnc
        : undefined;
    return {
      name: step.name,
      kind: step.kind,
      config: {
        ...config,
        ...(secret ? { secretEnc: encrypt(secret) } : carried ? { secretEnc: carried } : {}),
      },
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.retries !== undefined ? { retries: step.retries } : {}),
    };
  });
}

/** Stored step → browser view (secret reduced to a presence flag). */
export function toStepView(step: WorkflowStepDef): WorkflowStepView {
  const { secretEnc, ...rest } = step.config;
  return {
    name: step.name,
    kind: step.kind,
    config: { ...rest, ...(secretEnc ? { hasSecret: true } : {}) },
    timeoutMs: step.timeoutMs ?? null,
    retries: step.retries ?? null,
  };
}

/** Bounded pretty-print for outputs/inputs shown in the timeline. */
export function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined || text === 'null') return null;
  return text.length > OUTPUT_PRETTY_LIMIT ? `${text.slice(0, OUTPUT_PRETTY_LIMIT)}…` : text;
}

// ── row ↔ view mapping ───────────────────────────────────────────────────────

const RUN_STATUS_TO_VIEW: Record<string, WorkflowRunStatusView> = {
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting-approval',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const STEP_STATUS_SET = new Set<string>(['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']);

interface DefRow {
  id: string;
  name: string;
  stackName: string | null;
  version: number;
  stepsJson: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** `WorkflowDefView` + the stack-scoped IA field (local until core absorbs it). */
export type WorkflowDefFullView = WorkflowDefView & { stackName: string | null };

interface RunRow {
  id: string;
  defId: string;
  status: string;
  cursor: number;
  stateJson: unknown;
  startedAt: Date;
  finishedAt: Date | null;
}

interface StepRunRow {
  index: number;
  name: string;
  kind: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  outputJson: unknown;
  error: string | null;
}

function runToView(
  row: RunRow,
  def: Pick<DefRow, 'name' | 'version' | 'stepsJson' | 'stackName'>,
  now: Date,
): WorkflowRunView {
  const steps = parseSteps(def.stepsJson);
  const status = RUN_STATUS_TO_VIEW[row.status] ?? 'running';
  const cursor = Math.min(row.cursor, Math.max(0, steps.length - 1));
  return {
    id: row.id,
    defId: row.defId,
    defName: def.name,
    defVersion: def.version,
    stackName: def.stackName,
    status,
    cursor: row.cursor,
    totalSteps: steps.length,
    currentStep: steps[cursor]?.name ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: Math.max(0, (row.finishedAt ?? now).getTime() - row.startedAt.getTime()),
  };
}

function stepRunToView(row: StepRunRow): WorkflowStepRunView {
  return {
    index: row.index,
    name: row.name,
    kind: (KIND_SET.has(row.kind) ? row.kind : 'container') as WorkflowStepKind,
    status: (STEP_STATUS_SET.has(row.status) ? row.status : 'pending') as WorkflowStepStatusView,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    output: prettyJson(row.outputJson),
    error: row.error,
  };
}

async function latestDefByName(ctx: OrgContext, name: string): Promise<DefRow> {
  const row = await ctx.db.workflowDef.findFirst({
    where: { orgId: ctx.activeOrgId, name },
    orderBy: { version: 'desc' },
  });
  if (!row) throw notFound('workflow', name);
  return row;
}

async function requireRun(ctx: OrgContext, runId: string): Promise<RunRow & { def: DefRow }> {
  const row = await ctx.db.workflowRun.findFirst({
    where: { id: runId, orgId: ctx.activeOrgId },
    include: { def: true },
  });
  if (!row) throw notFound('workflow run', runId);
  return row;
}

// ── queries ──────────────────────────────────────────────────────────────────

export async function overview(ctx: OrgContext, stack?: string): Promise<WorkflowsOverview> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const scope = stack ? { def: { stackName: stack } } : {};
  const [defs, active, recent] = await Promise.all([
    ctx.db.workflowDef.findMany({
      where: { orgId: ctx.activeOrgId, ...(stack ? { stackName: stack } : {}) },
      orderBy: { version: 'desc' },
      select: { name: true, enabled: true },
    }),
    ctx.db.workflowRun.groupBy({
      by: ['status'],
      where: { orgId: ctx.activeOrgId, status: { in: ['RUNNING', 'WAITING_APPROVAL'] }, ...scope },
      _count: true,
    }),
    ctx.db.workflowRun.findMany({
      where: { orgId: ctx.activeOrgId, finishedAt: { gte: since }, ...scope },
      select: { status: true },
    }),
  ]);
  const names = new Map<string, boolean>();
  for (const d of defs) if (!names.has(d.name)) names.set(d.name, d.enabled);
  return {
    defs: names.size,
    enabled: [...names.values()].filter(Boolean).length,
    running: active.find((a) => a.status === 'RUNNING')?._count ?? 0,
    waitingApproval: active.find((a) => a.status === 'WAITING_APPROVAL')?._count ?? 0,
    succeeded24h: recent.filter((r) => r.status === 'SUCCEEDED').length,
    failed24h: recent.filter((r) => r.status === 'FAILED').length,
  };
}

/** Latest version per name, with last-run status for the defs list. */
export async function listDefs(ctx: OrgContext, stack?: string): Promise<WorkflowDefFullView[]> {
  const rows = await ctx.db.workflowDef.findMany({
    where: { orgId: ctx.activeOrgId, ...(stack ? { stackName: stack } : {}) },
    orderBy: [{ name: 'asc' }, { version: 'desc' }],
  });
  const latest: DefRow[] = [];
  const versions = new Map<string, number>();
  for (const row of rows) {
    versions.set(row.name, (versions.get(row.name) ?? 0) + 1);
    if (latest[latest.length - 1]?.name !== row.name) latest.push(row);
  }
  const lastRuns = await ctx.db.workflowRun.findMany({
    where: { orgId: ctx.activeOrgId, defId: { in: rows.map((r) => r.id) } },
    orderBy: { startedAt: 'desc' },
    distinct: ['defId'],
    select: { defId: true, status: true, startedAt: true },
  });
  const byDefId = new Map(lastRuns.map((r) => [r.defId, r]));
  return latest.map((row) => {
    // Last run across ALL versions of the name (newest version first wins).
    const versionIds = rows.filter((r) => r.name === row.name).map((r) => r.id);
    const last = versionIds
      .map((id) => byDefId.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    return {
      id: row.id,
      name: row.name,
      stackName: row.stackName,
      version: row.version,
      versions: versions.get(row.name) ?? 1,
      enabled: row.enabled,
      steps: parseSteps(row.stepsJson).map(toStepView),
      lastRunAt: last?.startedAt.toISOString() ?? null,
      lastRunStatus: last ? (RUN_STATUS_TO_VIEW[last.status] ?? 'running') : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/** Full version history for one name (newest first). */
export async function listVersions(ctx: OrgContext, name: string): Promise<WorkflowDefVersionView[]> {
  const rows = await ctx.db.workflowDef.findMany({
    where: { orgId: ctx.activeOrgId, name },
    orderBy: { version: 'desc' },
  });
  if (rows.length === 0) throw notFound('workflow', name);
  return rows.map((row) => {
    const steps = parseSteps(row.stepsJson);
    return {
      id: row.id,
      version: row.version,
      stepCount: steps.length,
      stepNames: steps.map((s) => s.name),
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function listRuns(
  ctx: OrgContext,
  input: WorkflowRunsInput & { stack?: string },
): Promise<WorkflowRunsPage> {
  const now = new Date();
  const rows = await ctx.db.workflowRun.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(input.defName || input.stack
        ? {
            def: {
              ...(input.defName ? { name: input.defName } : {}),
              ...(input.stack ? { stackName: input.stack } : {}),
            },
          }
        : {}),
    },
    include: { def: { select: { name: true, version: true, stepsJson: true, stackName: true } } },
    orderBy: { startedAt: 'desc' },
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, input.limit);
  return {
    runs: page.map((r) => runToView(r, r.def, now)),
    nextCursor: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getRun(ctx: OrgContext, runId: string): Promise<WorkflowRunDetailView> {
  const row = await requireRun(ctx, runId);
  const stepRuns = await ctx.db.workflowStepRun.findMany({
    where: { orgId: ctx.activeOrgId, runId },
    orderBy: { index: 'asc' },
  });
  const steps = parseSteps(row.def.stepsJson);
  const state = parseRunState(row.stateJson);
  const waiting = row.status === 'WAITING_APPROVAL' ? steps[row.cursor] : undefined;
  return {
    ...runToView(row, row.def, new Date()),
    input: prettyJson(state.input),
    steps: stepRuns.map(stepRunToView),
    approvalPrompt: waiting?.config.prompt ?? (waiting ? `Approve step "${waiting.name}"?` : null),
  };
}

// ── def mutations ────────────────────────────────────────────────────────────

function assertValidSteps(steps: WorkflowStepInput[]): void {
  const problems = validateSteps(steps);
  if (problems.length > 0) throw commandRejected(problems.join('; '));
}

export async function createDef(
  ctx: OrgContext,
  input: CreateWorkflowDefInput & { stackName?: string },
): Promise<WorkflowDefFullView> {
  assertValidSteps(input.steps);
  const existing = await ctx.db.workflowDef.findFirst({
    where: { orgId: ctx.activeOrgId, name: input.name },
    select: { id: true },
  });
  if (existing) throw commandRejected(`a workflow named "${input.name}" already exists`);
  const row = await ctx.db.workflowDef.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      stackName: input.stackName ?? null,
      version: 1,
      stepsJson: toStoredSteps(input.steps) as object,
      enabled: input.enabled,
    },
  });
  await writeAudit(ctx, {
    action: 'workflow.create',
    targetType: 'workflowDef',
    targetId: row.id,
    metadata: {
      name: input.name,
      ...(input.stackName ? { stackName: input.stackName } : {}),
      steps: input.steps.map((s) => `${s.kind}:${s.name}`),
    },
  });
  const [view] = (await listDefs(ctx)).filter((d) => d.name === input.name);
  return view!;
}

/** Edit = a NEW version row; history (and in-flight runs' pinned steps) stay intact. */
export async function updateDef(
  ctx: OrgContext,
  input: UpdateWorkflowDefInput & { stackName?: string },
): Promise<WorkflowDefFullView> {
  assertValidSteps(input.steps);
  const prev = await latestDefByName(ctx, input.name);
  const row = await ctx.db.workflowDef.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      // Carry the stack forward unless the edit explicitly re-homes it.
      stackName: input.stackName !== undefined ? input.stackName : prev.stackName,
      version: prev.version + 1,
      stepsJson: toStoredSteps(input.steps, parseSteps(prev.stepsJson)) as object,
      enabled: input.enabled ?? prev.enabled,
    },
  });
  await writeAudit(ctx, {
    action: 'workflow.update',
    targetType: 'workflowDef',
    targetId: row.id,
    metadata: { name: input.name, version: row.version },
  });
  const [view] = (await listDefs(ctx)).filter((d) => d.name === input.name);
  return view!;
}

export async function setEnabled(
  ctx: OrgContext,
  input: { name: string; enabled: boolean },
): Promise<{ name: string; enabled: boolean }> {
  await latestDefByName(ctx, input.name); // 404 for unknown/foreign names
  await ctx.db.workflowDef.updateMany({
    where: { orgId: ctx.activeOrgId, name: input.name },
    data: { enabled: input.enabled },
  });
  await writeAudit(ctx, {
    action: 'workflow.setEnabled',
    targetType: 'workflowDef',
    targetId: input.name,
    metadata: { enabled: input.enabled },
  });
  return { name: input.name, enabled: input.enabled };
}

/** Delete every version of the name (runs cascade — audited). */
export async function removeDef(ctx: OrgContext, name: string): Promise<{ name: string }> {
  await latestDefByName(ctx, name);
  await ctx.db.workflowDef.deleteMany({ where: { orgId: ctx.activeOrgId, name } });
  await writeAudit(ctx, { action: 'workflow.remove', targetType: 'workflowDef', targetId: name });
  return { name };
}

// ── run mutations ────────────────────────────────────────────────────────────

/** Parse the trigger payload: JSON when it parses, the raw string otherwise. */
export function parseTriggerInput(inputJson: string | undefined): unknown {
  if (inputJson === undefined || inputJson.trim() === '') return null;
  try {
    return JSON.parse(inputJson) as unknown;
  } catch {
    return inputJson;
  }
}

/**
 * Start a run: status running, cursor 0, `stateJson {input, steps: []}`, plus
 * one pending `WorkflowStepRun` row per step so the timeline is complete from
 * the first render. Also the seam the inbound-webhook target (B4) calls.
 */
export async function triggerWorkflow(
  ctx: OrgContext,
  input: TriggerWorkflowInput,
): Promise<{ runId: string; defId: string }> {
  // Guard direct (non-router) callers: an undefined name would otherwise drop
  // the Prisma filter and match an arbitrary def.
  if (!input.defId && !input.name) throw commandRejected('defId or name required');
  const def = input.defId
    ? await ctx.db.workflowDef.findFirst({ where: { id: input.defId, orgId: ctx.activeOrgId } })
    : await latestDefByName(ctx, input.name!);
  if (!def) throw notFound('workflow', input.defId ?? input.name);
  if (!def.enabled) throw commandRejected(`workflow "${def.name}" is disabled`);
  const steps = parseSteps(def.stepsJson);
  if (steps.length === 0) throw commandRejected(`workflow "${def.name}" has no steps`);

  const state: WorkflowRunState = { input: parseTriggerInput(input.inputJson), steps: [] };
  const run = await ctx.db.workflowRun.create({
    data: {
      orgId: ctx.activeOrgId,
      defId: def.id,
      status: 'RUNNING',
      cursor: 0,
      stateJson: state as object,
    },
    select: { id: true },
  });
  await ctx.db.workflowStepRun.createMany({
    data: steps.map((step, index) => ({
      orgId: ctx.activeOrgId,
      runId: run.id,
      index,
      name: step.name,
      kind: step.kind,
      status: 'pending',
    })),
  });
  await writeAudit(ctx, {
    action: 'workflow.trigger',
    targetType: 'workflowRun',
    targetId: run.id,
    metadata: { name: def.name, version: def.version },
  });
  return { runId: run.id, defId: def.id };
}

/**
 * Cancel an active run. Guarded writes mean an in-flight step attempt's
 * completion (runner `where status: 'running'`) becomes a no-op afterwards;
 * the agent still kills the container at its `timeoutMs` (best-effort).
 */
export async function cancelRun(ctx: OrgContext, runId: string): Promise<{ runId: string }> {
  const run = await requireRun(ctx, runId);
  const updated = await ctx.db.workflowRun.updateMany({
    where: { id: runId, orgId: ctx.activeOrgId, status: { in: ['RUNNING', 'WAITING_APPROVAL'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (updated.count === 0) throw commandRejected('run is already finished');
  await ctx.db.workflowStepRun.updateMany({
    where: { runId, orgId: ctx.activeOrgId, status: { in: ['running', 'waiting'] } },
    data: { status: 'cancelled', finishedAt: new Date(), error: 'cancelled by user' },
  });
  await writeAudit(ctx, {
    action: 'workflow.cancelRun',
    targetType: 'workflowRun',
    targetId: runId,
    metadata: { name: run.def.name },
  });
  return { runId };
}

/**
 * Approve the waiting approval step: record the decision as the step's output,
 * advance the cursor and resume (or finish) the run — mirroring the runner's
 * `advanceState` succeeded-transition exactly.
 */
export async function approveRun(ctx: OrgContext, input: WorkflowDecisionInput): Promise<{ runId: string }> {
  const run = await requireDecision(ctx, input.runId);
  const steps = parseSteps(run.def.stepsJson);
  const step = steps[run.cursor]!;
  const state = parseRunState(run.stateJson);
  const output = { approved: true, by: ctx.user?.email ?? 'system', ...(input.note ? { note: input.note } : {}) };
  state.steps = [...state.steps, { name: step.name, output }];
  delete state.nextEligibleAt;
  const nextCursor = run.cursor + 1;
  const finished = nextCursor >= steps.length;

  await ctx.db.workflowStepRun.updateMany({
    where: { runId: run.id, orgId: ctx.activeOrgId, index: run.cursor, status: 'waiting' },
    data: { status: 'succeeded', finishedAt: new Date(), outputJson: output },
  });
  const updated = await ctx.db.workflowRun.updateMany({
    where: { id: run.id, orgId: ctx.activeOrgId, status: 'WAITING_APPROVAL' },
    data: {
      status: finished ? 'SUCCEEDED' : 'RUNNING',
      cursor: nextCursor,
      stateJson: state as object,
      ...(finished ? { finishedAt: new Date() } : {}),
    },
  });
  if (updated.count === 0) throw commandRejected('run is no longer waiting for approval');
  await writeAudit(ctx, {
    action: 'workflow.approve',
    targetType: 'workflowRun',
    targetId: run.id,
    metadata: { name: run.def.name, step: step.name, ...(input.note ? { note: input.note } : {}) },
  });
  return { runId: run.id };
}

/** Reject the waiting approval step → the step and the run fail (audited). */
export async function rejectRun(ctx: OrgContext, input: WorkflowDecisionInput): Promise<{ runId: string }> {
  const run = await requireDecision(ctx, input.runId);
  const steps = parseSteps(run.def.stepsJson);
  const step = steps[run.cursor]!;
  const state = parseRunState(run.stateJson);
  const error = `rejected by ${ctx.user?.email ?? 'system'}${input.note ? `: ${input.note}` : ''}`;
  state.steps = [...state.steps, { name: step.name, error }];

  await ctx.db.workflowStepRun.updateMany({
    where: { runId: run.id, orgId: ctx.activeOrgId, index: run.cursor, status: 'waiting' },
    data: { status: 'failed', finishedAt: new Date(), error },
  });
  const updated = await ctx.db.workflowRun.updateMany({
    where: { id: run.id, orgId: ctx.activeOrgId, status: 'WAITING_APPROVAL' },
    data: { status: 'FAILED', stateJson: state as object, finishedAt: new Date() },
  });
  if (updated.count === 0) throw commandRejected('run is no longer waiting for approval');
  await writeAudit(ctx, {
    action: 'workflow.reject',
    targetType: 'workflowRun',
    targetId: run.id,
    metadata: { name: run.def.name, step: step.name, ...(input.note ? { note: input.note } : {}) },
  });
  return { runId: run.id };
}

async function requireDecision(ctx: OrgContext, runId: string): Promise<RunRow & { def: DefRow }> {
  const run = await requireRun(ctx, runId);
  if (run.status !== 'WAITING_APPROVAL') throw commandRejected('run is not waiting for approval');
  const steps = parseSteps(run.def.stepsJson);
  if (steps[run.cursor]?.kind !== 'approval') throw commandRejected('current step is not an approval');
  return run;
}
