import { describe, expect, test } from 'bun:test';
import type { QueueView } from '@swarmy/core';
import { autoscaleLine, calmLine, workerCooldown } from './autoscale-words';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const q = (over: Partial<QueueView> = {}): QueueView =>
  ({
    name: 'emails',
    workerService: 'storefront_email-worker',
    stack: 'storefront',
    scalePerJobs: 25,
    minWorkers: 1,
    maxWorkers: 4,
    cooldownSeconds: 600,
    workers: { desired: 4, running: 4 },
    calm: null,
    ...over,
  }) as QueueView;

describe('autoscale words', () => {
  test('the rule line says the cooldown the worker really waits', () => {
    expect(autoscaleLine(q())).toBe(
      'Autoscale: email-worker 1 → 4 copies, one per 25 waiting jobs, back to 1 after 10 min calm.',
    );
    expect(autoscaleLine(q({ cooldownSeconds: 0 }))).toContain("back to 1 as soon as it's calm");
    expect(autoscaleLine(q({ maxWorkers: 1 }))).toBe('Workers: email-worker stays at 1 copy.');
  });

  test('a running calm clock says when the copies drop', () => {
    const calm = { since: new Date(T0 - 4 * 60_000).toISOString(), peak: 2 };
    expect(calmLine(q({ calm }), 600, T0)).toBe('Calm for 4 min: down to 2 copies in 6 min.');
    expect(calmLine(q({ calm }), 600, T0 + 6 * 60_000 - 30_000)).toBe('Calm for 10 min: down to 2 copies within a minute.');
    expect(calmLine(q(), 600, T0)).toBeNull();
    expect(calmLine(q({ calm, workers: { desired: 2, running: 2 } }), 600, T0)).toBeNull();
  });

  test('a worker with several queues waits out the longest cooldown', () => {
    const all = [q(), q({ name: 'carts', cooldownSeconds: 900 }), q({ workerService: 'other', cooldownSeconds: 3600 })];
    expect(workerCooldown(all, 'storefront_email-worker')).toBe(900);
  });
});
