import { describe, expect, test } from 'bun:test';
import type { QueueConnectedView, QueueDepthSample, QueueView } from '@swarmy/core';
import { CONCURRENCY_NOTE, workerSay, workerTech } from './worker-words';
import type { WorkerRow } from './workers-model';

const q = (name: string, over: Partial<QueueView> = {}): QueueView =>
  ({
    name,
    workerService: 'shop_mailer',
    convention: 'bullmq',
    cacheName: 'jobs',
    scalePerJobs: 25,
    minWorkers: 1,
    maxWorkers: 4,
    cooldownSeconds: 600,
    ...over,
  }) as QueueView;
const row = (queues: QueueView[]): WorkerRow => ({ service: 'shop_mailer', part: 'mailer', inv: null, queues, copies: { desired: 3, running: 3 } });
const depth = new Map<string, QueueDepthSample | null>([['shop_mailer/emails', { wait: 38, active: 2, failed: 0, delayed: 0, ts: 't' }]]);
const conn = (over: Partial<QueueConnectedView>): QueueConnectedView => ({
  queue: 'emails',
  workerService: 'shop_mailer',
  connected: 3,
  names: [],
  reason: null,
  measuredAt: 't',
  ...over,
});

describe('worker row words', () => {
  test('a BullMQ queue says how many workers are connected, not a concurrency it cannot know', () => {
    const connected = new Map([['shop_mailer/emails', conn({ names: ['mailer-1'] })]]);
    expect(workerSay(row([q('emails')]), depth, connected)).toBe('3 copies · emails: 38 waiting, 2 in progress, 3 workers connected');
    expect(workerTech(row([q('emails')]), connected)).toBe(
      `emails bullmq on jobs · 1–4 copies, 1 per 25 waiting, back to 1 after 10 min calm · 3 connected (CLIENT LIST, as Queue.getWorkers()): mailer-1 · ${CONCURRENCY_NOTE}`,
    );
  });

  test('a raw list or a silent cache says so; before the read nothing is claimed', () => {
    const outbox = q('outbox', { convention: 'list' });
    const connected = new Map([
      ['shop_mailer/outbox', conn({ queue: 'outbox', connected: null, reason: 'raw-list' })],
      ['shop_mailer/emails', conn({ connected: null, reason: 'unreachable' })],
    ]);
    expect(workerTech(row([outbox]), connected)).toBe(
      "outbox list on jobs · 1–4 copies, 1 per 25 waiting, back to 1 after 10 min calm · a raw list's consumers don't name their connections",
    );
    expect(workerTech(row([q('emails')]), connected)).toContain("connections not read: the cache didn't answer");
    expect(workerSay(row([q('emails')]), depth, new Map())).toBe('3 copies · emails: 38 waiting, 2 in progress');
    expect(workerSay(row([q('carts')]), depth, new Map())).toBe('3 copies · carts: not measured yet');
  });
});
