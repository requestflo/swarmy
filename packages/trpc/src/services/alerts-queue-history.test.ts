import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { STACK_LABEL, type QueueDef } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { QUEUE_HISTORY_MAX, queueHistory, queueHistoryWindow, queueSubjectName } from './alerts-queue-history';
import { encodeQueuesLabel } from './queues.service';

/**
 * alerts.queueHistory over a real telemetry.db: the evaluator's subjects
 * (worker part × queue, narrowed by the rule's target), each with its BullMQ
 * queue's deepest backlog per 5 minutes, the org wall, and raw lists named
 * as left out.
 */

const NOW = Date.UTC(2026, 9, 24, 12, 2, 30);
const def = (name: string, more: Partial<QueueDef> = {}): QueueDef => ({ name, cacheCluster: 'jobs', convention: 'bullmq', scalePerJobs: 25, minWorkers: 1, maxWorkers: 5, cooldownSeconds: 300, retries: 3, dlq: true, ...more });
const worker = (stack: string, name: string, defs: QueueDef[]) => ({
  id: `svc-${name}`, name, image: 'shop/worker:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
  labels: { [STACK_LABEL]: stack, 'swarmy.queues': encodeQueuesLabel(defs) }, networks: [], env: [], ports: [], mounts: [],
});

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
}, 30_000);
afterEach(async () => {
  await t.close();
});

function ctx(services: unknown[], orgId = 'org'): OrgContext {
  return { activeOrgId: orgId, telemetry: t.telemetry, hub: { liveInventory: () => ({ services, containers: [] }) } } as unknown as OrgContext;
}
const sample = (orgId: string, stack: string, queue: string, at: number, waiting: number, prefix = 'bull') =>
  t.telemetry.queueStatSample.create({ data: { orgId, stack, cluster: 'jobs', prefix, queue, bucketStart: new Date(at), waiting, active: 0 } });

const SERVICES = [
  worker('shop', 'shop_worker', [def('emails'), def('outbox', { convention: 'list', listKey: 'outbox' })]),
  worker('admin', 'admin_mailer', [def('digest')]),
];

describe('alerts.queueHistory', () => {
  it('one subject per worker part × queue, each its deepest backlog per slot; raw lists are named as left out', async () => {
    const w = queueHistoryWindow(NOW);
    const at = (i: number) => w.from + i * w.step * 1000;
    await sample('org', 'shop', 'emails', at(10), 1_200);
    await sample('org', 'shop', 'emails', at(10), 1_450, 'custom'); // another prefix, same slot: the deeper one
    await sample('org', 'shop', 'emails', at(w.slots - 1), 80);
    await sample('org', 'admin', 'digest', at(3), 7);
    await sample('other', 'shop', 'emails', at(11), 99_999); // another org, same names
    const v = await queueHistory(ctx(SERVICES), {}, NOW);
    expect([v.stepSeconds, v.from, v.tooMany]).toEqual([300, new Date(w.from).toISOString(), null]);
    expect(v.queues.map((q) => q.name)).toEqual(['admin / mailer · digest', 'shop / worker · emails']);
    const emails = v.queues[1]!.peaks;
    expect(emails).toHaveLength(2016);
    expect([emails[10], emails[11], emails[w.slots - 1]]).toEqual([1_450, null, 80]);
    expect(emails.filter((x) => x !== null)).toEqual([1_450, 80]);
    expect(v.untracked).toEqual(['shop / worker · outbox']);
  });

  it('narrowed like the evaluator: one app, or one part of it', async () => {
    await sample('org', 'admin', 'digest', NOW - 600_000, 7);
    await sample('org', 'shop', 'emails', NOW - 600_000, 9);
    expect((await queueHistory(ctx(SERVICES), { app: 'admin' }, NOW)).queues.map((q) => q.name)).toEqual(['admin / mailer · digest']);
    const part = await queueHistory(ctx(SERVICES), { app: 'shop', service: 'worker' }, NOW);
    expect([part.queues.map((q) => q.name), part.untracked]).toEqual([['shop / worker · emails'], ['shop / worker · outbox']]);
    expect((await queueHistory(ctx(SERVICES), { app: 'shop', service: 'web' }, NOW)).queues).toEqual([]);
  });

  it('a queue with no samples this week is left out (no flat line), and another org sees nothing', async () => {
    await sample('org', 'shop', 'emails', NOW - 600_000, 9);
    expect((await queueHistory(ctx(SERVICES, 'other'), {}, NOW)).queues).toEqual([]);
  });

  it('more watched queues than one replay reads: none read, the count returned', async () => {
    const many = [worker('shop', 'shop_worker', Array.from({ length: QUEUE_HISTORY_MAX + 1 }, (_, i) => def(`q${i}`)))];
    expect(await queueHistory(ctx(many), {}, NOW)).toMatchObject({ queues: [], tooMany: QUEUE_HISTORY_MAX + 1 });
  });

  it('subject names follow the stack naming', () => {
    expect(queueSubjectName({ workerService: 'shop_worker', stack: 'shop', name: 'emails' })).toBe('shop / worker · emails');
    expect(queueSubjectName({ workerService: 'mailer', stack: '', name: 'digest' })).toBe('mailer · digest');
  });
});
