import type { QueueCalm, QueueDef } from './views';

/**
 * Queue autoscale with a scale-down cooldown — PURE, shared by the
 * queue-reconcile worker (the decision), the queues view (the calm clock) and
 * the dashboard (the rule line). Unit-tested in queue-autoscale.test.ts.
 *
 * Up is immediate: a tick whose depth asks for more copies than run gets
 * them. Down waits until every tick for `cooldownSeconds` asked for fewer
 * copies, then goes to the MOST any of those ticks asked for (a
 * stabilisation window), so a queue that dips between bursts doesn't flap
 * its workers.
 *
 * The calm clock lives on the worker service (`swarmy.queues.calm`), so a
 * controller restart keeps it. Minutes nobody measured don't count as calm:
 * a gap between samples longer than CALM_MAX_GAP_MS (a controller restart
 * fits; an outage doesn't) starts the clock again — the safe side is to
 * hold the copies.
 */

export const QUEUES_CALM_LABEL = 'swarmy.queues.calm';
export const DEFAULT_QUEUE_COOLDOWN_SECONDS = 600;
export const MAX_QUEUE_COOLDOWN_SECONDS = 86_400;
export const CALM_MAX_GAP_MS = 5 * 60_000;
/** A scale push not yet visible in the inventory is re-sent after this long. */
export const SCALE_PUSH_RETRY_MS = 60_000;

/** clamp(ceil(wait / scalePerJobs), minWorkers, maxWorkers) — copies the depth asks for. */
export function desiredWorkers(
  def: Pick<QueueDef, 'scalePerJobs' | 'minWorkers' | 'maxWorkers'>,
  wait: number,
): number {
  const raw = Math.ceil(Math.max(0, wait) / Math.max(1, def.scalePerJobs));
  const min = Math.max(0, def.minWorkers);
  const max = Math.max(min, def.maxWorkers);
  return Math.min(max, Math.max(min, raw));
}

/** Parse the `swarmy.queues.calm` label; anything malformed is no clock. */
export function parseQueueCalmLabel(raw: string | undefined | null): QueueCalm | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<QueueCalm> | null;
    if (typeof o?.since !== 'string' || !Number.isFinite(Date.parse(o.since))) return null;
    if (typeof o.peak !== 'number' || !Number.isInteger(o.peak) || o.peak < 0) return null;
    return { since: o.since, peak: o.peak };
  } catch {
    return null;
  }
}

export function encodeQueueCalmLabel(c: QueueCalm): string {
  return JSON.stringify({ since: c.since, peak: c.peak });
}

export interface AutoscaleInput {
  /** Copies the worker service is set to now. */
  current: number;
  /** Copies this tick's depth asks for (`desiredWorkers`, max across queues). */
  target: number;
  cooldownSeconds: number;
  /** The calm clock as last kept (label after a restart, else memory). */
  calm: QueueCalm | null;
  /** When the previous sample was taken (ms), null when unknown. */
  lastSampleAt: number | null;
  now: number;
}

export type AutoscaleMove = 'up' | 'steady' | 'calming' | 'down';

export interface AutoscaleStep {
  move: AutoscaleMove;
  /** Copies to set: `current` unless the move is up or down. */
  replicas: number;
  /** The calm clock to keep (null = none running). */
  calm: QueueCalm | null;
  /** While calming: when the copies drop (ms). */
  downAt: number | null;
}

function continues(i: AutoscaleInput): i is AutoscaleInput & { calm: QueueCalm } {
  if (!i.calm || i.lastSampleAt === null) return false;
  if (i.now - i.lastSampleAt > CALM_MAX_GAP_MS) return false;
  return Date.parse(i.calm.since) <= i.now && i.calm.peak < i.current;
}

/** One tick of the autoscaler: up now, down only after the cooldown. */
export function autoscaleStep(i: AutoscaleInput): AutoscaleStep {
  const target = Math.max(0, Math.floor(i.target));
  if (target > i.current) return { move: 'up', replicas: target, calm: null, downAt: null };
  if (target === i.current) return { move: 'steady', replicas: i.current, calm: null, downAt: null };
  const kept = continues(i) ? i.calm : null;
  const since = kept?.since ?? new Date(i.now).toISOString();
  const peak = Math.max(kept?.peak ?? 0, target);
  const downAt = Date.parse(since) + Math.max(0, i.cooldownSeconds) * 1000;
  if (i.now < downAt) return { move: 'calming', replicas: i.current, calm: { since, peak }, downAt };
  // Down to the most the window asked for; anything lower starts a fresh window now.
  const calm = target < peak ? { since: new Date(i.now).toISOString(), peak: target } : null;
  return { move: 'down', replicas: peak, calm, downAt: null };
}

/**
 * Signature gate for the scale push: nothing when the live copies already
 * match; a push already sent for the same count waits for the inventory to
 * catch up, and is re-sent only after `retryMs`.
 */
export function scalePushDue(
  live: number,
  want: number,
  last: { replicas: number; at: number } | undefined,
  now: number,
  retryMs = SCALE_PUSH_RETRY_MS,
): boolean {
  if (live === want) return false;
  return !(last && last.replicas === want && now - last.at < retryMs);
}

/** "10 min", "45 s", "2 h", "1 h 30 min" — a cooldown in words. */
export function cooldownWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** The scale-down half of the rule: "back to 1 after 10 min calm". */
export function scaleDownWords(minWorkers: number, cooldownSeconds: number): string {
  if (cooldownSeconds <= 0) return `back to ${minWorkers} as soon as it's calm`;
  return `back to ${minWorkers} after ${cooldownWords(cooldownSeconds)} calm`;
}
