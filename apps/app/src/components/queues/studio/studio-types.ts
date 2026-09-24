import type { BullJobRow, BullQueueSample } from '@swarmy/core/protocol';

export type { BullJobRow };

/** Mirrors `@swarmy/trpc` queue-studio.service `StudioQueueView`. */
export interface StudioQueue extends BullQueueSample {
  backlog: number;
  rate: {
    completed: number;
    failed: number;
    intervalSeconds: number;
    throughput: number;
    failureRate: number;
    failureRatio: number | null;
    saturated: boolean;
  } | null;
}

/** The cluster a studio page is bound to (+ BullMQ prefix). */
export interface StudioRef {
  stack: string;
  cluster: string;
  prefix: string;
}

export const STUDIO_STATES = [
  { id: 'wait', label: 'Waiting' },
  { id: 'active', label: 'Active' },
  { id: 'delayed', label: 'Delayed' },
  { id: 'prioritized', label: 'Prioritized' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'paused', label: 'Paused' },
  { id: 'waiting-children', label: 'Children' },
] as const;
export type StudioState = (typeof STUDIO_STATES)[number]['id'];

/** Count for a state tab out of the sample's counts. */
export function stateCount(q: BullQueueSample, s: StudioState): number {
  const c = q.counts;
  switch (s) {
    case 'wait':
      return c.wait;
    case 'active':
      return c.active;
    case 'delayed':
      return c.delayed;
    case 'prioritized':
      return c.prioritized;
    case 'completed':
      return c.completed;
    case 'failed':
      return c.failed;
    case 'paused':
      return c.paused;
    case 'waiting-children':
      return c.waitingChildren;
  }
}

/** `timestamp`-style ms fields → a short local time, or '—'. */
export function msTime(v: string | null | undefined): string {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleString();
}

/** Attempts made: BullMQ v5 writes `atm`, older jobs `attemptsMade`. */
export function attempts(j: BullJobRow): number {
  return Number(j.atm ?? j.attemptsMade ?? 0) || 0;
}

/** Pretty-print a JSON string when it parses; else return it as is. */
export function pretty(raw: string | null | undefined): string {
  if (raw == null) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Progress (JSON number or object) → a 0..100 number when numeric. */
export function progressPct(raw: string | null | undefined): number | null {
  const n = Number(raw);
  return raw != null && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}
