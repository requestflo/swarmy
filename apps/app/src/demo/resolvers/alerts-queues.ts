import { selectorMatches, subjectFromResource, type AlertQueueHistoryView, type QueueView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * `alerts.queueHistory` demo: a week of 5-minute backlog peaks for every
 * BullMQ queue a queue-depth rule watches (the queues demo's own list,
 * narrowed the way the controller narrows it), ending on each queue's depth
 * now. image-resize backed up past 1,000 for about 40 minutes three days ago
 * (a catalogue import) and twice briefly since; emails peaks every afternoon
 * but stays in the hundreds. platform's webhook-outbox is a raw list, so it
 * keeps no history and is named as left out.
 */

const STEP_S = 300;
const SLOTS = (7 * 86_400) / STEP_S;
const HOUR = 3_600_000;

const name = (q: QueueView): string => {
  const part = q.workerService.startsWith(`${q.stack}_`) ? q.workerService.slice(q.stack.length + 1) : q.workerService;
  return `${q.stack} / ${part} · ${q.name}`;
};

/** 0 at 04:00 UTC → 1 mid-afternoon. */
const busy = (t: number): number => 0.5 + 0.5 * Math.sin(((new Date(t).getUTCHours() - 10) / 24) * 2 * Math.PI);

function depth(q: QueueView, t: number, now: number): number {
  const ago = (now - t) / HOUR;
  const base = q.stats?.wait ?? 0;
  if (q.name === 'image-resize') {
    if (ago >= 71.3 && ago < 72) return 1_350 + Math.round((72 - ago) * 900);
    if ((ago >= 30 && ago < 30.1) || (ago >= 9 && ago < 9.1)) return 1_080;
    return Math.round(base * (0.3 + 0.9 * busy(t)));
  }
  return Math.round(base * (0.2 + 4 * busy(t)));
}

function queueHistory(input: unknown, s: DemoStore): AlertQueueHistoryView {
  const sel = (input ?? {}) as { app?: string; service?: string };
  const all = (s.extra.queues as { queues: QueueView[] } | undefined)?.queues ?? [];
  const watched = all.filter((q) => selectorMatches(sel, subjectFromResource(`queue:${q.workerService}/${q.name}`)));
  const now = Date.now();
  const from = (Math.floor(now / 1000 / STEP_S) - SLOTS + 1) * STEP_S * 1000;
  const queues = watched
    .filter((q) => q.convention === 'bullmq')
    .map((q) => ({ name: name(q), peaks: Array.from({ length: SLOTS }, (_, i) => (i === SLOTS - 1 ? (q.stats?.wait ?? 0) : depth(q, from + i * STEP_S * 1000, now))) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { from: new Date(from).toISOString(), stepSeconds: STEP_S, queues, untracked: watched.filter((q) => q.convention !== 'bullmq').map(name), tooMany: null };
}

export const alertsQueues: DomainResolvers = {
  handlers: { 'alerts.queueHistory': queueHistory },
};
