import {
  autoscaleStep,
  desiredWorkers,
  encodeQueueCalmLabel,
  parseQueueCalmLabel,
  scalePushDue,
  type AutoscaleStep,
  type QueueCalm,
  type QueueDef,
  type QueueDepthSample,
} from '@swarmy/core';

/**
 * One worker service's tick of the queue autoscaler — PURE, so the worker
 * only ticks (queue-reconcile.core.test.ts). The rule itself is
 * `autoscaleStep` in `@swarmy/core` queue-autoscale.ts: up now, down only
 * after the cooldown. This module decides what to WRITE: the stats stamp,
 * the calm clock label, and a scale push behind the signature gate.
 *
 * The calm clock is read from this process's memory when it has one (the
 * inventory can lag a label write by a tick) and from the
 * `swarmy.queues.calm` label otherwise, so a restart picks it back up. The
 * last sample time after a restart is the newest `ts` in the stats stamp.
 */

export interface WorkerMemo {
  calm: QueueCalm | null;
  /** When this worker's queues were last sampled (ms). */
  sampledAt: number;
  /** The last scale push this process sent, until the inventory shows it. */
  pushed?: { replicas: number; at: number };
}

export interface WorkerTick {
  defs: QueueDef[];
  /** This tick's samples by queue name (a queue missing here wasn't measured). */
  fresh: ReadonlyMap<string, QueueDepthSample>;
  /** The `swarmy.queues.stats` stamp as live (parsed). */
  prevStats: Record<string, QueueDepthSample>;
  /** Raw live label values, compared before writing. */
  liveStats: string | undefined;
  liveCalm: string | undefined;
  /** Copies the service is set to now. */
  current: number;
  /** False for a global-mode service (nothing to scale). */
  scalable: boolean;
  now: number;
}

export interface WorkerPlan {
  /** New stats stamp, or null when unchanged. */
  stats: string | null;
  /** Calm label: a value to write, null to remove it, undefined to leave it. */
  calm: string | null | undefined;
  /** Copies to push, or null (steady, calming, or already pushed). */
  scale: number | null;
  step: AutoscaleStep | null;
  memo: WorkerMemo | undefined;
}

function newestTs(stats: Record<string, QueueDepthSample>): number | null {
  let best: number | null = null;
  for (const s of Object.values(stats)) {
    const t = Date.parse(s.ts);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

export function planWorkerTick(t: WorkerTick, memo: WorkerMemo | undefined): WorkerPlan {
  const next: Record<string, QueueDepthSample> = {};
  let target: number | null = null;
  let cooldown = 0;
  for (const def of t.defs) {
    const s = t.fresh.get(def.name);
    if (!s) {
      // Keep the last-known stamp so the dashboard doesn't blank out.
      const kept = t.prevStats[def.name];
      if (kept) next[def.name] = kept;
      continue;
    }
    next[def.name] = s;
    // Several queues on one worker: the most copies any asks for, the longest cooldown.
    target = Math.max(target ?? 0, desiredWorkers(def, s.wait));
    cooldown = Math.max(cooldown, def.cooldownSeconds);
  }
  const encoded = JSON.stringify(next);
  const stats = Object.keys(next).length > 0 && encoded !== t.liveStats ? encoded : null;
  // Never scale blind off stale numbers, and a global service has no count.
  if (target === null || !t.scalable) return { stats, calm: undefined, scale: null, step: null, memo };

  const step = autoscaleStep({
    current: t.current,
    target,
    cooldownSeconds: cooldown,
    calm: memo ? memo.calm : parseQueueCalmLabel(t.liveCalm),
    lastSampleAt: memo ? memo.sampledAt : newestTs(t.prevStats),
    now: t.now,
  });
  const wantCalm = step.calm ? encodeQueueCalmLabel(step.calm) : null;
  const calm = wantCalm !== null ? (wantCalm === t.liveCalm ? undefined : wantCalm) : t.liveCalm !== undefined ? null : undefined;
  const pushed = memo?.pushed && memo.pushed.replicas !== t.current ? memo.pushed : undefined;
  const scale = scalePushDue(t.current, step.replicas, pushed, t.now) ? step.replicas : null;
  return { stats, calm, scale, step, memo: { calm: step.calm, sampledAt: t.now, ...(pushed ? { pushed } : {}) } };
}
