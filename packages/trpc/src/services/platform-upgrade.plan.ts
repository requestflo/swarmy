/**
 * The platform upgrade step engine (plans/epic-platform-upgrades.md §2) — pure.
 *
 *   preflight → controller → agents → system → engines → verify
 *
 * A run is a persisted list of per-step states. {@link driveRun} walks it from
 * the current step, checkpointing after every transition, so a run survives
 * the controller restarting ITSELF (the controller step replaces this very
 * process): the new controller loads the row and calls `driveRun` again, and
 * each handler reads its own `data` to pick up exactly where it stopped.
 *
 * Handler contract:
 *  - return `done` / `skipped` → next step;
 *  - return `wait` → the run stays `running` on this step and the driver
 *    returns (the resume tick re-drives it later) — e.g. the controller step
 *    after it asked Swarm to replace the controller;
 *  - throw → that step's `rollback` runs (when it has one), the step is marked
 *    `rolled-back` (or `failed` when it had none / rollback failed), and the
 *    run halts `failed` with a plain-words reason. A failed run is resumable:
 *    {@link retryRun} re-arms the failed step (its `data` is kept, so work it
 *    already did is not redone).
 *
 * The IO lives in `platform-upgrade.service.ts`; everything here is unit-tested
 * with fake handlers in `platform-upgrade.test.ts`.
 */

export const STEP_ORDER = ['preflight', 'controller', 'agents', 'system', 'engines', 'verify'] as const;
export type StepKey = (typeof STEP_ORDER)[number];

export const STEP_LABEL: Record<StepKey, string> = {
  preflight: 'Preflight',
  controller: 'Controller',
  agents: 'Agents',
  system: 'System services',
  engines: 'Engine upgrades',
  verify: 'Verify',
};

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'skipped' | 'failed' | 'rolled-back';
export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface StepState {
  key: StepKey;
  status: StepStatus;
  detail?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Handler-owned resume state (dispatched-at, per-node progress, engine run id, …). */
  data?: Record<string, unknown>;
}

export interface RunState {
  status: RunStatus;
  step: StepKey;
  steps: StepState[];
  error?: string | null;
  log: Array<{ at: string; msg: string }>;
}

export type StepOutcome =
  | { status: 'done' | 'skipped'; detail?: string }
  | { status: 'wait'; detail?: string };

export interface StepContext {
  run: RunState;
  step: StepState;
  /** Persist the run now (handlers call it after each unit of work). */
  checkpoint: () => Promise<void>;
  note: (msg: string) => void;
}

export interface StepHandler {
  run: (c: StepContext) => Promise<StepOutcome>;
  /** Undo this step's own effects after it failed. Returns a plain-words result. */
  rollback?: (c: StepContext, error: string) => Promise<string | void>;
}

export type StepHandlers = Record<StepKey, StepHandler>;

export function initialSteps(): StepState[] {
  return STEP_ORDER.map((key) => ({ key, status: 'pending' as const }));
}

export function newRunState(): RunState {
  return { status: 'running', step: 'preflight', steps: initialSteps(), error: null, log: [] };
}

const LOG_TAIL = 200;

export function noteOn(run: RunState, msg: string, now: () => Date = () => new Date()): void {
  run.log = [...run.log, { at: now().toISOString(), msg }].slice(-LOG_TAIL);
}

function stepOf(run: RunState, key: StepKey): StepState {
  let s = run.steps.find((x) => x.key === key);
  if (!s) {
    s = { key, status: 'pending' };
    run.steps = [...run.steps, s].sort((a, b) => STEP_ORDER.indexOf(a.key) - STEP_ORDER.indexOf(b.key));
  }
  return s;
}

export type DriveResult = 'done' | 'failed' | 'waiting' | 'idle';

/**
 * Drive a run from its current step. Idempotent across restarts: finished
 * steps are skipped, the current one is re-entered with its `data`.
 */
export async function driveRun(
  run: RunState,
  handlers: StepHandlers,
  persist: (run: RunState) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<DriveResult> {
  if (run.status !== 'running') return 'idle';
  const note = (msg: string) => noteOn(run, msg, now);
  const checkpoint = () => persist(run);
  for (let i = Math.max(0, STEP_ORDER.indexOf(run.step)); i < STEP_ORDER.length; i++) {
    const key = STEP_ORDER[i]!;
    const step = stepOf(run, key);
    if (step.status === 'done' || step.status === 'skipped') continue;
    run.step = key;
    if (step.status !== 'running' && step.status !== 'waiting') note(`${STEP_LABEL[key]}: started`);
    step.status = 'running';
    step.startedAt ??= now().toISOString();
    await checkpoint();
    const c: StepContext = { run, step, checkpoint, note };
    let outcome: StepOutcome;
    try {
      outcome = await handlers[key].run(c);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      step.error = reason;
      step.status = 'failed';
      note(`${STEP_LABEL[key]} failed: ${reason}`);
      const rb = handlers[key].rollback;
      if (rb) {
        try {
          const r = await rb(c, reason);
          step.status = 'rolled-back';
          note(`${STEP_LABEL[key]} rolled back${r ? `: ${r}` : ''}`);
        } catch (re) {
          note(`${STEP_LABEL[key]} ROLLBACK FAILED: ${re instanceof Error ? re.message : String(re)}`);
        }
      }
      step.finishedAt = now().toISOString();
      run.status = 'failed';
      run.error = `${STEP_LABEL[key]}: ${reason}`;
      await checkpoint();
      return 'failed';
    }
    if (outcome.status === 'wait') {
      step.status = 'waiting';
      if (outcome.detail) step.detail = outcome.detail;
      await checkpoint();
      return 'waiting';
    }
    step.status = outcome.status;
    if (outcome.detail) step.detail = outcome.detail;
    step.finishedAt = now().toISOString();
    note(`${STEP_LABEL[key]}: ${outcome.status}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
    await checkpoint();
  }
  run.status = 'done';
  run.error = null;
  await checkpoint();
  return 'done';
}

/** Re-arm a failed run at its failed step (keeps that step's data). Throws when not failed. */
export function retryRun(run: RunState, now: () => Date = () => new Date()): RunState {
  if (run.status !== 'failed') throw new Error(`only a failed run can be retried (this one is ${run.status})`);
  const step = stepOf(run, run.step);
  step.status = 'pending';
  step.error = undefined;
  step.finishedAt = undefined;
  run.status = 'running';
  run.error = null;
  noteOn(run, `retrying from ${STEP_LABEL[run.step]}`, now);
  return run;
}

/** Progress for the UI: finished steps / total. */
export function runProgress(run: Pick<RunState, 'steps' | 'status'>): { done: number; total: number } {
  const done = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { done: run.status === 'done' ? STEP_ORDER.length : done, total: STEP_ORDER.length };
}

// ── controller step decision ─────────────────────────────────────────────────

/** `repo[:tag]@sha256:…` → the digest, else null. */
export function digestOf(image: string | undefined | null): string | null {
  if (!image) return null;
  const at = image.lastIndexOf('@');
  if (at < 0) return null;
  const d = image.slice(at + 1);
  return /^sha256:[a-f0-9]{64}$/.test(d) ? d : null;
}

export interface ControllerDecisionInput {
  target: string | null;
  /** The live `swarmy_controller` service spec image; undefined = not seen (yet). */
  liveImage: string | undefined;
  liveUpdateState?: string;
  /** Was the service seen at all this boot? (hub warm) */
  inventoryReady: boolean;
  dispatchedAt?: string;
  /** When THIS process started (ms epoch). */
  processStartedAt: number;
  now: number;
  selfCommit?: string;
  targetCommit?: string;
  fromCommit?: string;
  timeoutMs?: number;
}

export type ControllerDecision =
  | { action: 'skip'; detail: string }
  | { action: 'done'; detail: string }
  | { action: 'dispatch' }
  | { action: 'wait'; detail: string }
  | { action: 'fail'; reason: string };

/**
 * What the controller step does now. The controller replaces itself, so this
 * is re-evaluated by the NEW process after the restart (processStartedAt is
 * then after dispatchedAt):
 *  - spec on the target and we started after the dispatch → we ARE the new controller;
 *  - spec not on the target and we started after the dispatch → Swarm's
 *    `failure_action: rollback` put the old controller back → fail;
 *  - we are still the old process → wait (Swarm stops us shortly), unless it
 *    never happened (timeout).
 * Pure.
 */
export function controllerStepDecision(i: ControllerDecisionInput): ControllerDecision {
  const timeout = i.timeoutMs ?? 15 * 60_000;
  const restarted = i.dispatchedAt ? i.processStartedAt > Date.parse(i.dispatchedAt) : false;
  const commitMoved = Boolean(i.targetCommit && i.selfCommit === i.targetCommit && i.fromCommit !== i.targetCommit);
  if (!i.target) return { action: 'skip', detail: 'this release carries no controller digest' };
  const live = digestOf(i.liveImage);
  if (!i.dispatchedAt) {
    if (i.liveImage === undefined) {
      if (!i.inventoryReady) return { action: 'wait', detail: 'waiting for the cluster inventory' };
      return { action: 'skip', detail: 'the controller does not run as a swarm service here (dev / external)' };
    }
    if (live === i.target) return { action: 'done', detail: 'already on the target build' };
    return { action: 'dispatch' };
  }
  if (restarted && (live === i.target || commitMoved)) return { action: 'done', detail: 'the new controller is up and resumed the run' };
  if (i.liveUpdateState === 'rollback_started' || i.liveUpdateState === 'rollback_completed') {
    return { action: 'fail', reason: 'the new controller did not become healthy; Swarm rolled back to the previous build' };
  }
  if (restarted && i.liveImage !== undefined && live !== i.target) {
    return { action: 'fail', reason: 'the new controller did not become healthy; Swarm rolled back to the previous build' };
  }
  if (restarted && i.liveImage === undefined) return { action: 'wait', detail: 'waiting for the cluster inventory after the restart' };
  if (i.now - Date.parse(i.dispatchedAt) > timeout) {
    return { action: 'fail', reason: 'Swarm never replaced the controller (update did not start within 15 minutes)' };
  }
  return { action: 'wait', detail: 'Swarm is replacing the controller; the new one resumes this run' };
}

// ── system services plan ─────────────────────────────────────────────────────

export interface SystemServiceUpdate {
  service: string;
  key: string;
  from: string;
  to: string;
}

/**
 * The platform services the system step rolls, in order (lower first): DNS →
 * edges → observability. Everything else in the BOM is either its own step
 * (controller, agents, Garage), the registry (never depends on itself; the
 * mirror lives on its node-local volume), a one-shot tool image, or a
 * data-plane image users' managed services run (valkey, …) — a platform
 * upgrade never restarts those.
 */
export const SYSTEM_ORDER: Record<string, number> = {
  dns: 1,
  caddySwarmy: 2,
  caddy: 2,
  otelCollector: 3,
  clickhouse: 4,
};

/** Services a platform run must NOT touch in the system step (own steps / not platform). */
export const SYSTEM_STEP_EXCLUDED = new Set(['swarmy_controller', 'swarmy-garage']);

/** Strip `@digest`, then `:tag`, then a mirror prefix `<host>/swarmy-system/` → `host/path`. Pure. */
export function repoOf(image: string, mirrorNamespace = 'swarmy-system'): string {
  let r = image.split('@')[0] ?? image;
  const slash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  if (colon > slash) r = r.slice(0, colon);
  const ns = `/${mirrorNamespace}/`;
  const at = r.indexOf(ns);
  if (at >= 0) r = r.slice(at + ns.length);
  const first = r.split('/')[0] ?? '';
  const hasHost = r.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!hasHost) r = r.includes('/') ? `docker.io/${r}` : `docker.io/library/${r}`;
  return r;
}

export interface ManifestComponentLite {
  ref: string;
  image: string;
  digest?: string;
}

/**
 * Which live system services need a new image for the target manifest. A
 * service matches a component when its image's repo equals the component's
 * dispatch repo or its published repo (mirrored copies included). `refFor`
 * picks the ref to roll to (mirrored when trusted, else upstream@digest). Pure.
 */
export function planSystemUpdates(
  services: Array<{ name: string; image: string; labels?: Record<string, string> }>,
  components: Record<string, ManifestComponentLite>,
  refFor: (key: string, c: ManifestComponentLite) => string,
): SystemServiceUpdate[] {
  const byRepo = new Map<string, string>();
  for (const [key, c] of Object.entries(components)) {
    if (!c.digest || SYSTEM_ORDER[key] === undefined) continue;
    byRepo.set(repoOf(c.ref), key);
    byRepo.set(repoOf(c.image), key);
  }
  const out: SystemServiceUpdate[] = [];
  for (const s of services) {
    if (SYSTEM_STEP_EXCLUDED.has(s.name)) continue;
    const system = s.name.startsWith('swarmy-') || s.labels?.['swarmy.system'] === 'true' || s.labels?.['com.docker.stack.namespace'] === 'swarmy-system';
    if (!system) continue;
    const key = byRepo.get(repoOf(s.image));
    if (!key) continue;
    const c = components[key]!;
    if (digestOf(s.image) === c.digest) continue;
    out.push({ service: s.name, key, from: s.image, to: refFor(key, c) });
  }
  return out.sort((a, b) => SYSTEM_ORDER[a.key]! - SYSTEM_ORDER[b.key]! || a.service.localeCompare(b.service));
}

// ── docker CLI one-shot scripts ──────────────────────────────────────────────

export const UPDATE_MARKER = '@@SWARMY-UPDATE@@';

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `docker service update` in the docker CLI one-shot (docker.sock bound).
 * Swarm does the health-gating: `--update-failure-action rollback` puts the
 * previous spec back when the new task fails within the monitor window. The
 * script prints `@@SWARMY-UPDATE@@ <rc> <UpdateStatus.State>` last. With
 * `detach`, it returns right after Swarm accepted the new spec (the controller
 * step: this process is about to be replaced). Registry creds come as env.
 */
export function serviceUpdateScript(service: string, image: string, opts: { detach?: boolean; monitor?: string; login?: string } = {}): string {
  const lines = ['set -u'];
  if (opts.login) {
    lines.push(
      `if [ -n "\${SWARMY_REG_USER:-}" ]; then printf '%s' "$SWARMY_REG_PASS" | docker login ${sq(opts.login)} -u "$SWARMY_REG_USER" --password-stdin >/dev/null 2>&1 && AUTH=--with-registry-auth; fi`,
    );
  }
  lines.push(
    `docker service update --quiet ${opts.detach ? '--detach' : '--detach=false'} \${AUTH:-} --image ${sq(image)} ` +
      `--update-failure-action rollback --update-monitor ${opts.monitor ?? '30s'} --update-parallelism 1 ${sq(service)}; RC=$?`,
    `ST=$(docker service inspect ${sq(service)} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null)`,
    `echo "${UPDATE_MARKER} $RC \${ST:-none}"`,
  );
  return lines.join('\n');
}

/** `docker service rollback` (previous spec) — the per-service undo. */
export function serviceRollbackScript(service: string): string {
  return [
    'set -u',
    `docker service rollback --quiet --detach=false ${sq(service)}; RC=$?`,
    `ST=$(docker service inspect ${sq(service)} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null)`,
    `echo "${UPDATE_MARKER} $RC \${ST:-none}"`,
  ].join('\n');
}

/** Parse the marker line → { rc, state }; rc -1 when absent. Pure. */
export function parseUpdateOutput(output: string): { rc: number; state: string } {
  const line = output
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(UPDATE_MARKER));
  if (!line) return { rc: -1, state: 'unknown' };
  const [, rc, state] = line.trim().split(/\s+/);
  return { rc: Number(rc ?? -1), state: state ?? 'none' };
}

/** Did the update land healthy? (Swarm rolled back = no.) Pure. */
export function updateLanded(r: { rc: number; state: string }): boolean {
  return r.rc === 0 && !r.state.startsWith('rollback') && r.state !== 'paused';
}
