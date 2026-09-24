/**
 * queueOp against a REAL Valkey with the real `bullmq` client producing and
 * processing jobs. The handler execs into the container exactly as it does on
 * a node (valkey-cli, password from /run/secrets/cache-password).
 *
 * Needs a local Docker daemon that can run `valkey/valkey:8`; skips otherwise.
 *   bun test src/handlers/queue-op.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Queue, Worker } from 'bullmq';
import { DockerClient } from '@swarmy/core/docker';
import {
  queueBacklog,
  VENDORED_BULLMQ_VERSION,
  type QueueJobReply,
  type QueueJobsReply,
  type QueueMutationReply,
  type QueueOpInput,
  type QueueOverviewReply,
  QueueOp,
} from '@swarmy/core/protocol';
import { BULLMQ_VENDORED } from '@swarmy/core/protocol';
import { constName, installedBullmqVersion, readInstalledScript, SCRIPTS } from './queue-op.vendor';
import { queueOp } from './queue-op';

const IMAGE = 'valkey/valkey:8';
const PASSWORD = 'studio-pw';
const docker = new DockerClient();

async function dockerReady(): Promise<boolean> {
  if (!(await docker.ping())) return false;
  try {
    await docker.docker.getImage(IMAGE).inspect();
    return true;
  } catch {
    try {
      await new Promise<void>((resolve, reject) => {
        docker.docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
        });
      });
      return true;
    } catch {
      return false;
    }
  }
}

const available = await dockerReady();

let containerId = '';
let port = 0;
const connection = () => ({ host: '127.0.0.1', port, password: PASSWORD, maxRetriesPerRequest: null });

async function op<T>(input: QueueOpInput): Promise<T> {
  return (await queueOp(docker, {
    commandId: crypto.randomUUID(),
    target: { containerId },
    engine: 'valkey',
    op: QueueOp.parse(input),
  })) as T;
}

async function waitFor(fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  throw new Error('timed out waiting');
}

describe('vendored BullMQ scripts', () => {
  test('match the installed bullmq exactly', async () => {
    expect(VENDORED_BULLMQ_VERSION).toBe(installedBullmqVersion());
    for (const f of SCRIPTS) {
      const v = (BULLMQ_VENDORED as unknown as Record<string, { content: string }>)[constName(f)];
      expect(v?.content).toBe(await readInstalledScript(f));
    }
  });
});

describe.skipIf(!available)('queueOp on a real valkey + bullmq', () => {
  let emails: Queue;
  let reports: Queue;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const c = await docker.docker.createContainer({
      Image: IMAGE,
      Cmd: [
        'sh',
        '-c',
        `mkdir -p /run/secrets && printf '%s' '${PASSWORD}' > /run/secrets/cache-password && ` +
          'exec valkey-server --requirepass "$(cat /run/secrets/cache-password)" --maxmemory-policy noeviction --appendonly yes',
      ],
      ExposedPorts: { '6379/tcp': {} },
      HostConfig: { PortBindings: { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] }, AutoRemove: true },
      Labels: { 'swarmy.test': 'queue-op' },
    });
    await c.start();
    containerId = c.id;
    const info = await c.inspect();
    port = Number(info.NetworkSettings.Ports['6379/tcp']?.[0]?.HostPort);
    emails = new Queue('emails', { connection: connection() });
    reports = new Queue('reports', { connection: connection() });
    await waitFor(async () => {
      try {
        await emails.getJobCounts();
        return true;
      } catch {
        return false;
      }
    });

    // Process 4 good + 3 failing jobs, then stop the worker.
    for (let i = 0; i < 4; i++) await emails.add('send', { to: `ok${i}@x.test` });
    for (let i = 0; i < 3; i++) await emails.add('send', { to: `bad${i}@x.test`, fail: true });
    const worker = new Worker(
      'emails',
      async (job) => {
        await job.updateProgress(50);
        await job.log(`sending to ${job.data.to}`);
        if (job.data.fail) throw new Error(`mailbox ${job.data.to} rejected`);
        return { sent: true };
      },
      { connection: connection() },
    );
    await waitFor(async () => {
      const n = await emails.getJobCounts('completed', 'failed');
      return n.completed === 4 && n.failed === 3;
    });
    await worker.close();

    // Leave work behind: 2 waiting, 2 delayed, 1 prioritized; one report.
    ids.wait1 = (await emails.add('send', { to: 'later1@x.test' })).id!;
    ids.wait2 = (await emails.add('send', { to: 'later2@x.test' })).id!;
    ids.delayed1 = (await emails.add('send', { to: 'd1@x.test' }, { delay: 600_000 })).id!;
    ids.delayed2 = (await emails.add('send', { to: 'd2@x.test' }, { delay: 600_000 })).id!;
    ids.prio = (await emails.add('send', { to: 'vip@x.test' }, { priority: 1 })).id!;
    await reports.add('build', { big: 'x'.repeat(10_000) });
  }, 90_000);

  afterAll(async () => {
    await emails?.close();
    await reports?.close();
    if (containerId) await docker.docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
  });

  test('overview discovers every queue by key pattern and matches bullmq counts', async () => {
    const ov = await op<QueueOverviewReply>({ kind: 'overview' });
    expect(ov.truncated).toBe(false);
    expect(ov.queues.map((q) => q.name)).toEqual(['emails', 'reports']);
    const e = ov.queues[0]!;
    const truth = await emails.getJobCounts();
    expect(e.counts.completed).toBe(truth.completed!);
    expect(e.counts.failed).toBe(truth.failed!);
    expect(e.counts.wait).toBe(truth.waiting!);
    expect(e.counts.delayed).toBe(truth.delayed!);
    expect(e.counts.prioritized).toBe(truth.prioritized!);
    expect(e.counts.active).toBe(0);
    expect(e.counts).toMatchObject({ completed: 4, failed: 3, wait: 2, delayed: 2, prioritized: 1 });
    expect(e.isPaused).toBe(false);
    expect(e.jobsTotal).toBe(12);
    expect(e.events.lastId).toMatch(/^\d+-\d+$/);
    // The autoscaler's backlog is exactly what BullMQ would hand a worker next.
    expect(queueBacklog(e)).toBe((await emails.getWaitingCount()) + (await emails.getPrioritizedCount()));
    // An explicit list skips the scan (the queue-reconcile path).
    const one = await op<QueueOverviewReply>({ kind: 'overview', queues: ['reports'] });
    expect(one.queues.map((q) => q.name)).toEqual(['reports']);
    expect(one.queues[0]!.counts.wait).toBe(1);
  });

  test('rate sampling counts completed/failed events after a cursor', async () => {
    const before = await op<QueueOverviewReply>({ kind: 'overview', queues: ['reports'] });
    const cursor = before.queues[0]!.events.lastId!;
    const w = new Worker('reports', async () => 'ok', { connection: connection() });
    await waitFor(async () => (await reports.getCompletedCount()) === 1);
    await w.close();
    const after = await op<QueueOverviewReply>({
      kind: 'overview',
      queues: ['reports'],
      eventsSince: { reports: cursor },
    });
    expect(after.queues[0]!.events).toMatchObject({ completed: 1, failed: 0, saturated: false });
    expect(after.queues[0]!.events.lastId).not.toBe(cursor);
  });

  test('job pages carry payload, progress, attempts and failed reason', async () => {
    const failed = await op<QueueJobsReply>({ kind: 'jobs', queue: 'emails', state: 'failed' });
    expect(failed.total).toBe(3);
    expect(failed.jobs).toHaveLength(3);
    const j = failed.jobs[0]!;
    expect(JSON.parse(j.data!).fail).toBe(true);
    expect(j.failedReason).toMatch(/rejected/);
    expect(j.progress).toBe('50');
    expect(Number(j.atm ?? j.attemptsMade)).toBe(1);
    expect(j.stacktrace).toBeUndefined();

    const delayed = await op<QueueJobsReply>({ kind: 'jobs', queue: 'emails', state: 'delayed' });
    expect(delayed.jobs.map((x) => x.id).sort()).toEqual([ids.delayed1!, ids.delayed2!].sort());
    expect(delayed.jobs[0]!.runAt).toBeGreaterThan(Date.now());

    const big = await op<QueueJobsReply>({ kind: 'jobs', queue: 'reports', state: 'completed' });
    expect(big.jobs[0]!.dataTruncated).toBe(true);
    expect(big.jobs[0]!.data!.length).toBe(2048);

    const empty = await op<QueueJobsReply>({ kind: 'jobs', queue: 'emails', state: 'active' });
    expect(empty).toMatchObject({ total: 0, jobs: [] });
  });

  test('job detail has the stacktrace, state and logs', async () => {
    const failed = await op<QueueJobsReply>({ kind: 'jobs', queue: 'emails', state: 'failed' });
    const d = await op<QueueJobReply>({ kind: 'job', queue: 'emails', id: failed.jobs[0]!.id });
    if (!d.found) throw new Error('job not found');
    expect(d.state).toBe('failed');
    expect(JSON.parse(d.job.stacktrace!)[0]).toMatch(/rejected/);
    expect(d.logs[0]).toMatch(/^sending to bad/);
    expect(d.logCount).toBe(1);
    const missing = await op<QueueJobReply>({ kind: 'job', queue: 'emails', id: 'nope' });
    expect(missing.found).toBe(false);
  });

  test('retry moves one failed job back to waiting (BullMQ Job.retry semantics)', async () => {
    const failed = await op<QueueJobsReply>({ kind: 'jobs', queue: 'emails', state: 'failed' });
    const id = failed.jobs[0]!.id;
    const r = await op<QueueMutationReply>({ kind: 'retry', queue: 'emails', id });
    expect(r.ok).toBe(true);
    expect(await emails.getJobState(id)).toBe('waiting');
    const again = await op<QueueMutationReply>({ kind: 'retry', queue: 'emails', id });
    expect(again).toMatchObject({ ok: false, code: -3 });
    const gone = await op<QueueMutationReply>({ kind: 'retry', queue: 'emails', id: '9999' });
    expect(gone).toMatchObject({ ok: false, code: -1 });
  });

  test('retryAll moves the rest of failed back to waiting', async () => {
    const r = await op<QueueMutationReply>({ kind: 'retryAll', queue: 'emails', timestamp: Date.now() });
    expect(r).toMatchObject({ ok: true, more: false });
    expect(await emails.getFailedCount()).toBe(0);
  });

  test('promote one delayed job, then promoteAll', async () => {
    const r = await op<QueueMutationReply>({ kind: 'promote', queue: 'emails', id: ids.delayed1! });
    expect(r.ok).toBe(true);
    expect(await emails.getJobState(ids.delayed1!)).toBe('waiting');
    const notDelayed = await op<QueueMutationReply>({ kind: 'promote', queue: 'emails', id: ids.delayed1! });
    expect(notDelayed).toMatchObject({ ok: false, code: -3 });
    await op<QueueMutationReply>({ kind: 'promoteAll', queue: 'emails' });
    expect(await emails.getDelayedCount()).toBe(0);
  });

  test('pause and resume flip the queue as bullmq sees it', async () => {
    await op<QueueMutationReply>({ kind: 'pause', queue: 'emails', paused: true });
    expect(await emails.isPaused()).toBe(true);
    const ov = await op<QueueOverviewReply>({ kind: 'overview', queues: ['emails'] });
    expect(ov.queues[0]!.isPaused).toBe(true);
    expect(queueBacklog(ov.queues[0]!)).toBe(0);
    await op<QueueMutationReply>({ kind: 'pause', queue: 'emails', paused: false });
    expect(await emails.isPaused()).toBe(false);
  });

  test('remove deletes one job; clean empties a state; drain empties waiting', async () => {
    const r = await op<QueueMutationReply>({ kind: 'remove', queue: 'emails', id: ids.wait1! });
    expect(r.ok).toBe(true);
    expect(await emails.getJob(ids.wait1!)).toBeUndefined();

    const c = await op<QueueMutationReply>({ kind: 'clean', queue: 'emails', state: 'completed', timestamp: Date.now() });
    expect(c.removedIds).toHaveLength(4);
    expect(await emails.getCompletedCount()).toBe(0);

    await op<QueueMutationReply>({ kind: 'drain', queue: 'emails', delayed: true });
    const n = await emails.getJobCounts('wait', 'prioritized', 'delayed');
    expect(n).toEqual({ wait: 0, prioritized: 0, delayed: 0 });

    // A worker still consumes normally after studio writes (markers intact).
    await emails.add('send', { to: 'after@x.test' });
    const w = new Worker('emails', async () => 'ok', { connection: connection() });
    await waitFor(async () => (await emails.getCompletedCount()) === 1);
    await w.close();
  });

  test('ops refuse malformed names before they reach the engine', () => {
    expect(() => QueueOp.parse({ kind: 'jobs', queue: 'a:b', state: 'failed' })).toThrow();
    expect(() => QueueOp.parse({ kind: 'clean', queue: 'q', state: 'active', timestamp: 0 })).toThrow();
    expect(() => QueueOp.parse({ kind: 'remove', queue: 'q', id: 'x y' })).toThrow();
  });
});
