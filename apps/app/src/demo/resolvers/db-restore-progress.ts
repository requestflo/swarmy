import type { DbRestoreProgressView, DbRestoreStage } from '@swarmy/core';
import type { DemoHandler, DemoStore, DomainResolvers } from '../types';
import { data } from './data';
import { dbRestoreCopy } from './db-restore-copy';

/**
 * The demo's restore progress (`dbBackups.restoreProgress`): a restore or a
 * restore-as-copy started in the demo plays out its steps over a few seconds,
 * like the controller's relay — the numbers grow, a point in time replays
 * towards its target, and the finished run lingers a minute. Wraps data.ts's
 * `dbBackups.restore` and db-restore-copy's `restoreAsCopy` (so it comes
 * after both in the registry) and holds their answer until the steps end.
 */

interface DemoRun {
  ref: string;
  into: string;
  mode: DbRestoreProgressView['mode'];
  engine: string;
  targetTime: string | null;
  startedAt: number;
  copy: boolean;
}

const GB = 1024 ** 3;
const LINGER_MS = 60_000;

/** Each step and how long it takes in the demo (ms). */
function plan(r: DemoRun): Array<[DbRestoreStage, number]> {
  const head: Array<[DbRestoreStage, number]> = r.copy ? [['create', 2_500]] : [['safety', 1_500]];
  if (r.mode === 'pitr') return [...head, ['stop', 800], ['base', 3_000], ['wal', 1_500], ['start', 600], ['replay', 2_000], ['check', 600]];
  return [...head, ['download', 3_000], ['load', 2_000]];
}

const total = (r: DemoRun): number => plan(r).reduce((n, [, ms]) => n + ms, 0);

/** PURE: the relay's view of a demo run at `now`. */
export function demoRestoreView(r: DemoRun, now: number): DbRestoreProgressView {
  const done: DbRestoreProgressView['done'] = [];
  let t = r.startedAt;
  let current: { stage: DbRestoreStage; startedAt: number; frac: number } | null = null;
  for (const [stage, ms] of plan(r)) {
    if (now >= t + ms) done.push({ stage, startedAt: t, endedAt: t + ms });
    else if (!current) current = { stage, startedAt: t, frac: Math.max(0, (now - t) / ms) };
    t += ms;
  }
  const finished = current == null;
  const f = current?.frac ?? 0;
  const target = r.targetTime ? Date.parse(r.targetTime) : now;
  return {
    ref: r.ref, into: r.into, mode: r.mode, engine: r.engine, targetTime: r.targetTime,
    startedAt: r.startedAt, endedAt: finished ? t : null, status: finished ? 'succeeded' : 'running', error: null,
    done, current: current ? { stage: current.stage, startedAt: current.startedAt } : null,
    bytesDone: current?.stage === 'base' || current?.stage === 'download' ? Math.round(f * 4.1 * GB) : null,
    bytesTotal: current?.stage === 'base' || current?.stage === 'download' ? Math.round(4.1 * GB) : null,
    percent: current?.stage === 'download' ? Math.floor(f * 100) : null,
    segments: current?.stage === 'wal' ? Math.round(f * 412) : null,
    replayedTo: current?.stage === 'replay' ? new Date(target - (1 - f) * 3_600_000).toISOString() : null,
  };
}

const runs = (s: DemoStore): Record<string, DemoRun> => (s.extra.restoreRuns ??= {}) as Record<string, DemoRun>;

/** Start a run, then answer with the wrapped handler's result once its steps end. */
function played(inner: DemoHandler | undefined, copy: boolean): DemoHandler {
  return async (i, s) => {
    const b = i as { stack: string; cluster: string; engine: string; mode?: string; targetTime?: string; targetCluster?: string; name?: string };
    const mode = (b.mode ?? (b.targetTime ? 'pitr' : 'clone-to-new-cluster')) as DbRestoreProgressView['mode'];
    const run: DemoRun = {
      ref: `${b.stack}/${b.cluster}`,
      into: `${b.stack}/${copy ? (b.name ?? `${b.cluster}-restore`) : (b.targetCluster ?? b.cluster)}`,
      mode, engine: b.engine, targetTime: b.targetTime ?? null, startedAt: Date.now(), copy,
    };
    runs(s)[run.ref] = run;
    const result = await inner?.(i, s);
    const left = run.startedAt + total(run) - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    return result;
  };
}

export const dbRestoreProgress: DomainResolvers = {
  handlers: {
    'dbBackups.restore': played(data.handlers?.['dbBackups.restore'], false),
    'dbBackups.restoreAsCopy': played(dbRestoreCopy.handlers?.['dbBackups.restoreAsCopy'], true),
    'dbBackups.restoreProgress': (i, s): DbRestoreProgressView | null => {
      const b = i as { stack: string; cluster: string };
      const run = runs(s)[`${b.stack}/${b.cluster}`];
      if (!run) return null;
      const v = demoRestoreView(run, Date.now());
      return v.endedAt != null && Date.now() - v.endedAt > LINGER_MS ? null : v;
    },
  },
};
