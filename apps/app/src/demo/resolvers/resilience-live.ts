import type { ResilienceDrillKind, ResilienceDrillProgressView, ResilienceDrillStepView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's live drill (board 16's "Running · <step>"): a drill plays its
 * steps on a short clock and streams each one on `resilience.drillProgress`,
 * the way the controller's drill-progress relay does (a replay of the runs so
 * far, then every change; each event is the whole run). The run's record
 * still comes from resilience.ts once it ends.
 */

interface LiveDrills {
  runs: ResilienceDrillProgressView[];
  listeners: Set<(v: ResilienceDrillProgressView) => void>;
}

/** Demo seconds per step: long enough to read, short enough to wait for. */
const STEP_MS = 1_600;
const LINGER_MS = 60_000;

const live = (s: DemoStore): LiveDrills =>
  (s.extra.resilienceLive ??= { runs: [], listeners: new Set() }) as LiveDrills;

function publish(s: DemoStore, view: ResilienceDrillProgressView): void {
  const st = live(s);
  st.runs = [...st.runs.filter((r) => r.runId !== view.runId), view];
  for (const fn of [...st.listeners]) fn(view);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Walk `steps` live, then `finish()` (which records the run) and resolve with its result. */
export async function playDemoDrill<R extends { status: 'passed' | 'failed' }>(
  s: DemoStore,
  kind: ResilienceDrillKind,
  target: string | null,
  steps: ResilienceDrillStepView[],
  finish: () => R,
): Promise<R> {
  let view: ResilienceDrillProgressView = {
    runId: `drl_${Math.random().toString(16).slice(2, 18)}`,
    kind,
    target,
    startedAt: Date.now(),
    steps: [],
    current: null,
    status: null,
  };
  publish(s, view);
  for (const step of steps) {
    view = { ...view, current: { name: step.name, startedAt: Date.now() } };
    publish(s, view);
    await wait(STEP_MS);
    view = { ...view, steps: [...view.steps, step], current: null };
    publish(s, view);
  }
  const result = finish();
  publish(s, { ...view, status: result.status });
  return result;
}

export const resilienceLive: DomainResolvers = {
  subscriptions: {
    'resilience.drillProgress': (_i, s, emit) => {
      const st = live(s);
      st.runs = st.runs.filter((r) => r.status == null || Date.now() - r.startedAt < LINGER_MS);
      for (const r of st.runs) emit(r);
      st.listeners.add(emit);
      return () => st.listeners.delete(emit);
    },
  },
};
