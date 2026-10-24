/**
 * Live drill progress (board 16: the DR drill card's "Running · <step>").
 *
 * An in-memory relay with a replay, the same idea as the deploy-event bus
 * (`deploy-events.ts`) but smaller: the drill runner (`resilience.service`'s
 * `stepRecorder`) publishes each step as it starts and as it ends, and
 * `resilience.drillProgress` replays the org's runs then tails them. Every
 * event is the WHOLE run so far (`ResilienceDrillProgressView`), so the
 * replay is just the latest view of each run and a client keeps the newest
 * per `runId`. A finished run lingers a minute so a viewer sees how it ended.
 * Nothing persists here: a drill's record is its `resilience.drill` audit row.
 * Reads are org-scoped HERE (`live` / `subscribe` take the caller's org).
 */
import { randomBytes } from 'node:crypto';
import type {
  ResilienceDrillKind,
  ResilienceDrillProgressView,
  ResilienceDrillStatus,
  ResilienceDrillStepView,
} from '@swarmy/core';

/** A finished run stays visible this long. */
const LINGER_MS = 60_000;
/** A run nobody finished (a crash mid-drill) is dropped after this. */
const ABANDON_MS = 30 * 60_000;
const MAX_RUNS_PER_ORG = 20;

type Listener = (view: ResilienceDrillProgressView) => void;
interface Run {
  view: ResilienceDrillProgressView;
  endedAt: number | null;
}

/** The runner's handle on one run. Calls after `finish` are ignored. */
export interface DrillProgress {
  readonly runId: string;
  start(name: string): void;
  step(step: ResilienceDrillStepView): void;
  finish(status: ResilienceDrillStatus): void;
}

export class DrillProgressBus {
  private runs = new Map<string, Map<string, Run>>();
  private listeners = new Map<string, Set<Listener>>();
  constructor(private now: () => number = Date.now) {}

  begin(orgId: string, kind: ResilienceDrillKind, target: string | null): DrillProgress {
    const runs = this.orgRuns(orgId);
    this.sweep(runs);
    if (runs.size >= MAX_RUNS_PER_ORG) runs.delete(runs.keys().next().value as string);
    const runId = `drl_${randomBytes(8).toString('hex')}`;
    const run: Run = { view: { runId, kind, target, startedAt: this.now(), steps: [], current: null, status: null }, endedAt: null };
    runs.set(runId, run);
    const publish = (patch: Partial<ResilienceDrillProgressView>): void => {
      if (run.endedAt != null) return;
      run.view = { ...run.view, ...patch };
      for (const fn of [...(this.listeners.get(orgId) ?? [])]) fn(run.view);
    };
    publish({});
    return {
      runId,
      start: (name) => publish({ current: { name, startedAt: this.now() } }),
      step: (step) => publish({ steps: [...run.view.steps, step], current: null }),
      finish: (status) => {
        publish({ status, current: null });
        run.endedAt = this.now();
      },
    };
  }

  /** The org's runs in flight (and just finished), oldest first: the replay. */
  live(orgId: string): ResilienceDrillProgressView[] {
    const runs = this.runs.get(orgId);
    if (!runs) return [];
    this.sweep(runs);
    return [...runs.values()].map((r) => r.view).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Every change to one of the org's runs. Pair with `live` for the replay. */
  subscribe(orgId: string, fn: Listener): () => void {
    const set = this.listeners.get(orgId) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(orgId, set);
    return () => set.delete(fn);
  }

  private orgRuns(orgId: string): Map<string, Run> {
    const runs = this.runs.get(orgId) ?? new Map<string, Run>();
    this.runs.set(orgId, runs);
    return runs;
  }

  private sweep(runs: Map<string, Run>): void {
    const t = this.now();
    for (const [id, r] of runs) {
      if (r.endedAt != null ? t - r.endedAt > LINGER_MS : t - r.view.startedAt > ABANDON_MS) runs.delete(id);
    }
  }
}

/** Process-wide singleton shared by the drill runner and the router. */
export const drillProgressBus = new DrillProgressBus();

/** `resilience.drillProgress`: the org's runs so far, then every change, until the caller leaves. */
export async function* subscribeDrillProgress(
  orgId: string,
  signal: AbortSignal,
  bus: DrillProgressBus = drillProgressBus,
): AsyncIterable<ResilienceDrillProgressView> {
  const queue: ResilienceDrillProgressView[] = [];
  let wake: (() => void) | null = null;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  const off = bus.subscribe(orgId, (v) => {
    queue.push(v);
    poke();
  });
  // After subscribing: the replay is never older than anything already queued.
  queue.push(...bus.live(orgId));
  signal.addEventListener('abort', poke, { once: true });
  try {
    while (!signal.aborted) {
      while (queue.length) yield queue.shift() as ResilienceDrillProgressView;
      if (signal.aborted) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  } finally {
    off();
    signal.removeEventListener('abort', poke);
  }
}
