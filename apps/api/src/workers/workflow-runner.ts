import { createHmac } from 'node:crypto';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type {
  WorkflowRunState,
  WorkflowStepDef,
  WorkflowStepKind,
} from '@swarmy/core';
import { WORKFLOW_STEP_KINDS } from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import { hub } from '../gateway';

/**
 * Workflow-runner worker (slice B3). Every 5s: claim advancing runs (status
 * RUNNING, guarded/optimistic writes) and execute the current step —
 * `container` → `container.runOnce`, `service-exec` → `exec`, `webhook` →
 * signed POST, `approval` → park as WAITING_APPROVAL (the tRPC approve/reject
 * mutations advance it), `delay` → `nextEligibleAt` in stateJson. Per-step
 * timeout + retries with backoff; one `WorkflowStepRun` row per step; a failed
 * step (after retries) fails the run; after the last step the run succeeds.
 *
 * The step-transition reducer `advanceState` below is PURE and unit-tested
 * (workflow-runner.test.ts). The stepsJson/stateJson codecs mirror the
 * canonical copies in `@swarmy/trpc` workflows.service.ts — a worker cannot
 * subpath-import an internal trpc module (job-scheduler precedent).
 */

const TICK_MS = 5_000;
const DISPATCH_MARGIN_MS = 30_000;
const DEFAULT_STEP_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 65_536;
const WEBHOOK_BODY_TAIL_CHARS = 8_192;

// ── pure: codecs (mirror of workflows.service parseSteps/parseRunState) ──────

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

/** `WorkflowDef.stepsJson` → step defs (defensive against hand-edited rows). */
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

/** `WorkflowRun.stateJson` → run state (defensive). */
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

// ── pure: the step-transition reducer (unit-tested; all kinds route here) ────

/** What executing (or inspecting) the current step produced. */
export type StepOutcome =
  | { kind: 'succeeded'; output?: unknown }
  | { kind: 'failed'; error: string }
  | { kind: 'approval-pending' }
  | { kind: 'delay-pending'; resumeAt: string };

/** The slice of a run the reducer advances. */
export interface RunSnapshot {
  cursor: number;
  totalSteps: number;
  state: WorkflowRunState;
}

/** The next persistent state: what to write on the run + current step row. */
export interface NextRunState {
  runStatus: 'running' | 'waiting-approval' | 'succeeded' | 'failed';
  cursor: number;
  state: WorkflowRunState;
  stepStatus: 'running' | 'waiting' | 'succeeded' | 'failed';
  /** True when the run reached a terminal status. */
  finished: boolean;
}

/**
 * advanceState(run, stepResult) → next state. Pure: no clock, no IO. The
 * runner (and, for approvals, the tRPC approve/reject mutations) persist
 * exactly what this returns.
 */
export function advanceState(run: RunSnapshot, stepName: string, outcome: StepOutcome): NextRunState {
  const state: WorkflowRunState = { ...run.state, steps: [...run.state.steps] };
  switch (outcome.kind) {
    case 'succeeded': {
      state.steps.push({ name: stepName, ...(outcome.output !== undefined ? { output: outcome.output } : {}) });
      delete state.nextEligibleAt;
      const cursor = run.cursor + 1;
      const finished = cursor >= run.totalSteps;
      return {
        runStatus: finished ? 'succeeded' : 'running',
        cursor,
        state,
        stepStatus: 'succeeded',
        finished,
      };
    }
    case 'failed': {
      state.steps.push({ name: stepName, error: outcome.error });
      delete state.nextEligibleAt;
      return { runStatus: 'failed', cursor: run.cursor, state, stepStatus: 'failed', finished: true };
    }
    case 'approval-pending':
      return { runStatus: 'waiting-approval', cursor: run.cursor, state, stepStatus: 'waiting', finished: false };
    case 'delay-pending': {
      state.nextEligibleAt = outcome.resumeAt;
      return { runStatus: 'running', cursor: run.cursor, state, stepStatus: 'running', finished: false };
    }
  }
}

/** A delay step's park/advance decision (pure). */
export function delayOutcome(step: WorkflowStepDef, state: WorkflowRunState, now: Date): StepOutcome {
  const seconds = step.config.seconds ?? 0;
  if (seconds < 1) return { kind: 'failed', error: 'delay step has no seconds' };
  if (!state.nextEligibleAt) {
    return { kind: 'delay-pending', resumeAt: new Date(now.getTime() + seconds * 1_000).toISOString() };
  }
  if (new Date(state.nextEligibleAt).getTime() <= now.getTime()) {
    return { kind: 'succeeded', output: { delayedSeconds: seconds } };
  }
  return { kind: 'delay-pending', resumeAt: state.nextEligibleAt };
}

/** True when the run is parked on a future `nextEligibleAt`. */
export function isParked(state: WorkflowRunState, now: Date): boolean {
  return Boolean(state.nextEligibleAt && new Date(state.nextEligibleAt).getTime() > now.getTime());
}

/** Retry backoff: 5s, 10s, 20s, … capped at 60s (attempt is 1-based). */
export function retryBackoffMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

/** Webhook body: `{runId, input, prevOutput}` (prevOutput = last step output). */
export function buildWebhookBody(runId: string, state: WorkflowRunState): string {
  const prev = state.steps[state.steps.length - 1];
  return JSON.stringify({ runId, input: state.input ?? null, prevOutput: prev?.output ?? null });
}

/** `sha256=<hmac>` signature header value (webhooks-out convention). */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/** Map a `container.runOnce` result to a step outcome. */
export function outcomeFromRunOnce(res: Pick<RunOnceResult, 'exitCode' | 'output' | 'timedOut'>): StepOutcome {
  const output = { exitCode: res.exitCode, output: res.output.slice(-OUTPUT_TAIL_CHARS) };
  if (res.timedOut) return { kind: 'failed', error: `timed out (exit ${res.exitCode})` };
  if (res.exitCode !== 0) return { kind: 'failed', error: `exit code ${res.exitCode}: ${res.output.slice(-2_048)}` };
  return { kind: 'succeeded', output };
}

// ── execution (impure): one attempt per executing kind ──────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Any online node, workers preferred (one-shot utility containers). */
async function pickRunNode(orgId: string): Promise<string | null> {
  const rows = await prisma.node.findMany({ where: { orgId }, select: { id: true } });
  const online = rows.filter((r) => hub.isOnline(r.id));
  if (online.length === 0) return null;
  const worker = online.find((r) => hub.nodeInfoFor(r.id)?.role === 'worker');
  return (worker ?? online[0]!).id;
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

async function attemptContainer(orgId: string, step: WorkflowStepDef, timeoutMs: number): Promise<StepOutcome> {
  const nodeId = await pickRunNode(orgId);
  if (!nodeId) return { kind: 'failed', error: 'no online node to run the step' };
  const res = await hub.dispatch<RunOnceResult>(
    nodeId,
    'container.runOnce',
    { image: step.config.image, cmd: step.config.command ?? [], env: step.config.env ?? {}, timeoutMs },
    { timeoutMs: timeoutMs + DISPATCH_MARGIN_MS },
  );
  return outcomeFromRunOnce(res);
}

async function attemptServiceExec(orgId: string, step: WorkflowStepDef, timeoutMs: number): Promise<StepOutcome> {
  const target = findExecTarget(orgId, step.config.serviceRef ?? '');
  if (!target) {
    return { kind: 'failed', error: `no running container found for service "${step.config.serviceRef}"` };
  }
  const res = await hub.dispatch<{ exitCode: number; output?: string }>(
    target.nodeId,
    'exec',
    { target: { containerId: target.containerId }, cmd: step.config.command ?? [], tty: false, stream: false },
    { timeoutMs: timeoutMs + DISPATCH_MARGIN_MS },
  );
  const output = { exitCode: res.exitCode, output: (res.output ?? '').slice(-OUTPUT_TAIL_CHARS) };
  if (res.exitCode !== 0) return { kind: 'failed', error: `exit code ${res.exitCode}: ${output.output.slice(-2_048)}` };
  return { kind: 'succeeded', output };
}

async function attemptWebhook(
  runId: string,
  step: WorkflowStepDef,
  state: WorkflowRunState,
  timeoutMs: number,
): Promise<StepOutcome> {
  const body = buildWebhookBody(runId, state);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (step.config.secretEnc) {
    try {
      headers['X-Swarmy-Signature'] = signWebhookBody(decryptSecret(step.config.secretEnc), body);
    } catch {
      return { kind: 'failed', error: 'could not decrypt the webhook secret (vault key changed?)' };
    }
  }
  const res = await fetch(step.config.url ?? '', {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  const text = (await res.text().catch(() => '')).slice(0, WEBHOOK_BODY_TAIL_CHARS);
  if (!res.ok) return { kind: 'failed', error: `HTTP ${res.status}: ${text.slice(0, 2_048)}` };
  return { kind: 'succeeded', output: { status: res.status, body: text } };
}

/** One attempt of an executing step; thrown errors become failed outcomes. */
async function performAttempt(
  orgId: string,
  runId: string,
  step: WorkflowStepDef,
  state: WorkflowRunState,
): Promise<StepOutcome> {
  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  try {
    if (step.kind === 'container') return await attemptContainer(orgId, step, timeoutMs);
    if (step.kind === 'service-exec') return await attemptServiceExec(orgId, step, timeoutMs);
    if (step.kind === 'webhook') return await attemptWebhook(runId, step, state, timeoutMs);
    return { kind: 'failed', error: `step kind "${step.kind}" is not executable` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'failed', error: /time.?out|abort/i.test(message) ? `timed out: ${message}` : message };
  }
}

/** Retry loop: budget = 1 + retries, exponential backoff between attempts. */
async function executeWithRetries(
  orgId: string,
  runId: string,
  step: WorkflowStepDef,
  state: WorkflowRunState,
  stillRunning: () => Promise<boolean>,
): Promise<StepOutcome> {
  const budget = 1 + Math.max(0, step.retries ?? 0);
  let last: StepOutcome = { kind: 'failed', error: 'no attempts made' };
  for (let attempt = 1; attempt <= budget; attempt++) {
    last = await performAttempt(orgId, runId, step, state);
    if (last.kind !== 'failed') return last;
    if (attempt < budget) {
      await sleep(retryBackoffMs(attempt));
      if (!(await stillRunning())) return last; // cancelled mid-backoff
    }
  }
  return last;
}

// ── persistence: apply a NextRunState with guarded (optimistic) writes ───────

const RUN_STATUS_TO_DB = {
  running: 'RUNNING',
  'waiting-approval': 'WAITING_APPROVAL',
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
} as const;

interface RunRow {
  id: string;
  orgId: string;
  defId: string;
  status: string;
  cursor: number;
  stateJson: unknown;
}

/**
 * Persist the reducer's verdict. The run write is guarded on `status: RUNNING`
 * + the old cursor (the optimistic claim): a concurrent cancel/approve makes
 * it a no-op and we stop. Returns false when the claim was lost.
 */
async function applyNext(
  run: RunRow,
  stepIndex: number,
  outcome: StepOutcome,
  next: NextRunState,
): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.workflowRun.updateMany({
    where: { id: run.id, status: 'RUNNING', cursor: run.cursor },
    data: {
      status: RUN_STATUS_TO_DB[next.runStatus],
      cursor: next.cursor,
      stateJson: next.state as object,
      ...(next.finished ? { finishedAt: now } : {}),
    },
  });
  if (updated.count === 0) return false;

  const stepData =
    next.stepStatus === 'succeeded'
      ? {
          status: 'succeeded',
          finishedAt: now,
          ...(outcome.kind === 'succeeded' && outcome.output !== undefined
            ? { outputJson: outcome.output as object }
            : {}),
        }
      : next.stepStatus === 'failed'
        ? { status: 'failed', finishedAt: now, error: outcome.kind === 'failed' ? outcome.error : 'failed' }
        : // running (delay parked) / waiting (approval): stamp startedAt on the park
          { status: next.stepStatus, startedAt: now };
  await prisma.workflowStepRun.updateMany({
    where: { runId: run.id, index: stepIndex, status: { in: ['pending', 'running', 'waiting'] } },
    data: stepData,
  });
  return true;
}

/** Flip the current step row to running + stamp startedAt (idempotent). */
async function markStepRunning(runId: string, orgId: string, index: number, step: WorkflowStepDef): Promise<void> {
  // Trigger pre-creates pending rows; upsert covers hand-created runs.
  await prisma.workflowStepRun.upsert({
    where: { runId_index: { runId, index } },
    create: { orgId, runId, index, name: step.name, kind: step.kind, status: 'running', startedAt: new Date() },
    update: {},
  });
  await prisma.workflowStepRun.updateMany({
    where: { runId, index, status: 'pending' },
    data: { status: 'running', startedAt: new Date() },
  });
}

// ── the advance loop for one claimed run ─────────────────────────────────────

async function advanceRun(runId: string, ctx: OrgContext): Promise<void> {
  // Sequential steps execute back-to-back within one claim; we bail out on
  // parks (approval / future delay), terminal states, or a lost guard.
  for (;;) {
    const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { def: true } });
    if (!run || run.status !== 'RUNNING') return;
    const steps = parseSteps(run.def.stepsJson);
    const state = parseRunState(run.stateJson);
    const now = new Date();

    if (run.cursor >= steps.length) {
      // Defensive: an empty/over-advanced run finishes cleanly.
      await prisma.workflowRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'SUCCEEDED', finishedAt: now },
      });
      return;
    }
    const step = steps[run.cursor]!;
    const snapshot: RunSnapshot = { cursor: run.cursor, totalSteps: steps.length, state };

    let outcome: StepOutcome;
    if (step.kind === 'delay') {
      outcome = delayOutcome(step, state, now);
      if (outcome.kind === 'delay-pending' && state.nextEligibleAt) return; // already parked
    } else if (step.kind === 'approval') {
      outcome = { kind: 'approval-pending' };
    } else {
      await markStepRunning(run.id, run.orgId, run.cursor, step);
      const stillRunning = async (): Promise<boolean> => {
        const fresh = await prisma.workflowRun.findUnique({ where: { id: runId }, select: { status: true } });
        return fresh?.status === 'RUNNING';
      };
      outcome = await executeWithRetries(run.orgId, run.id, step, state, stillRunning);
    }

    const next = advanceState(snapshot, step.name, outcome);
    if (!(await applyNext(run, run.cursor, outcome, next))) return; // claim lost (cancelled/approved elsewhere)

    if (next.runStatus === 'failed') {
      await fireEvent(ctx, {
        signal: 'workflow-failed',
        severity: 'warning',
        resource: `workflow/${run.def.name}`,
        message: `Workflow "${run.def.name}" failed at step "${step.name}": ${
          outcome.kind === 'failed' ? outcome.error.slice(0, 300) : 'failed'
        }`,
      }).catch(() => undefined);
    }
    if (next.finished || next.runStatus === 'waiting-approval') return;
    if (outcome.kind === 'delay-pending') return; // parked until nextEligibleAt
  }
}

// ── tick ─────────────────────────────────────────────────────────────────────

/** Runs currently being advanced by THIS process (overlap guard). */
const inFlight = new Set<string>();

async function tick(now: Date): Promise<void> {
  const runs = await prisma.workflowRun.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, orgId: true, stateJson: true },
  });
  if (runs.length === 0) return;
  const auth = authRegistry.getAuth();
  for (const run of runs) {
    if (inFlight.has(run.id)) continue;
    if (isParked(parseRunState(run.stateJson), now)) continue;
    inFlight.add(run.id);
    const ctx = systemContext({ db: prisma, hub, auth }, run.orgId);
    // Detached: a 10-minute container must not block the 5s tick.
    void advanceRun(run.id, ctx)
      .catch(() => undefined)
      .finally(() => inFlight.delete(run.id));
  }
}

export function startWorkflowRunner(): () => void {
  const timer = setInterval(() => {
    tick(new Date()).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
