import { beforeEach, describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { resetQueueSampler, sampleQueueClusters, studioAction, studioOverview } from './queue-studio.service';

/**
 * Service wiring over a fake hub: the op reaches `queue.op` on the node that
 * runs the cache PRIMARY's container. Batched writes loop the way BullMQ does,
 * every write is audited, and the sampler turns events cursors into rates.
 * (The ops themselves run against a real valkey + bullmq in
 * apps/agent/src/handlers/queue-op.integration.test.ts.)
 */

const primary = {
  id: 'svc-primary',
  name: 'shop_jobs-cache',
  image: 'valkey/valkey:8',
  mode: 'replicated',
  replicas: 1,
  runningReplicas: 1,
  desiredReplicas: 1,
  labels: {
    'com.docker.stack.namespace': 'shop',
    'swarmy.cache.cluster': 'jobs',
    'swarmy.cache.role': 'primary',
    'swarmy.cache.engine': 'valkey',
    'swarmy.cache.purpose': 'queue',
    'swarmy.cache.topology': 'single',
    'swarmy.cache.memoryMb': '256',
    'swarmy.cache.replicas': '0',
  },
  networks: [],
  env: [],
  ports: [],
  createdAt: 0,
  updatedAt: 0,
};
const container = {
  id: 'ctr1',
  name: 'shop_jobs-cache.1',
  image: 'valkey/valkey:8',
  state: 'running',
  status: 'Up',
  serviceId: 'svc-primary',
  labels: { 'com.docker.swarm.service.id': 'svc-primary' },
};

function sample(name: string, events: { completed: number; failed: number; lastId: string }) {
  return {
    name,
    counts: { wait: 3, paused: 0, active: 1, prioritized: 2, delayed: 0, completed: 10, failed: 1, waitingChildren: 0 },
    isPaused: false,
    jobsTotal: 17,
    metricsCompleted: null,
    metricsFailed: null,
    events: { ...events, saturated: false },
  };
}

function ctxWith(reply: (op: { kind: string; eventsSince?: Record<string, string> }) => unknown) {
  const audit: { action: string; metadata: unknown }[] = [];
  const sent: { node: string; cmd: string; payload: { op: { kind: string }; target: { containerId: string } } }[] = [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      auditLog: { create: async ({ data }: { data: { action: string; metadata: unknown } }) => void audit.push(data) },
      observabilityConfig: { findFirst: async () => null, findUnique: async () => null },
    },
    hub: {
      liveInventory: () => ({ services: [primary], containers: [container] }),
      onlineNodeIds: () => ['node-a'],
      latestContainers: () => [container],
      managerNode: () => 'node-a',
      dispatch: async (node: string, cmd: string, payload: { op: { kind: string } }) => {
        sent.push({ node, cmd, payload: payload as never });
        return reply(payload.op);
      },
    },
  } as unknown as OrgContext;
  return { ctx, audit, sent };
}

beforeEach(() => resetQueueSampler());

describe('queue studio service', () => {
  it('dispatches queue.op to the primary container and adds the autoscaler backlog', async () => {
    const { ctx, sent } = ctxWith(() => ({
      queues: [sample('emails', { completed: 0, failed: 0, lastId: '5-0' })],
      truncated: false,
    }));
    const ov = await studioOverview(ctx, { stack: 'shop', cluster: 'jobs', prefix: 'bull' });
    expect(sent[0]).toMatchObject({ node: 'node-a', cmd: 'queue.op', payload: { target: { containerId: 'ctr1' } } });
    expect(ov.purpose).toBe('queue');
    expect(ov.queues[0]!.backlog).toBe(5);
    expect(ov.queues[0]!.rate).toBeNull();
  });

  it('retryAll loops while BullMQ reports more, then audits once', async () => {
    let calls = 0;
    const { ctx, audit } = ctxWith(() => ({ ok: true, code: ++calls < 3 ? 1 : 0, message: 'x', more: calls < 3 }));
    const r = await studioAction(ctx, { stack: 'shop', cluster: 'jobs', prefix: 'bull', queue: 'emails' }, {
      kind: 'retryAll',
      from: 'failed',
    });
    expect(r).toMatchObject({ ok: true, batches: 3 });
    expect(audit.map((a) => a.action)).toEqual(['queues.studio.retryAll']);
  });

  it('a refused write is audited and surfaces BullMQ’s reason', async () => {
    const { ctx, audit } = ctxWith(() => ({ ok: false, code: 0, message: 'job 7 is locked by a worker' }));
    const e = await studioAction(ctx, { stack: 'shop', cluster: 'jobs', prefix: 'bull', queue: 'emails' }, {
      kind: 'remove',
      id: '7',
    }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/locked/);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'queues.studio.remove', metadata: { id: '7', ok: false } });
  });

  it('unknown clusters are not found (managed caches only)', async () => {
    const { ctx } = ctxWith(() => ({}));
    await expect(studioOverview(ctx, { stack: 'shop', cluster: 'nope', prefix: 'bull' })).rejects.toThrow();
  });

  it('the sampler seeds a cursor, then reports per-minute rates from events after it', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    let tick = 0;
    const { ctx } = ctxWith((op) => {
      seen.push(op.eventsSince);
      tick++;
      return {
        queues: [sample('emails', tick === 1 ? { completed: 0, failed: 0, lastId: '5-0' } : { completed: 6, failed: 2, lastId: '9-0' })],
        truncated: false,
      };
    });
    const first = await sampleQueueClusters(ctx);
    expect(first[0]!.queues[0]!.name).toBe('emails');
    expect(seen[0]).toEqual({});
    await Bun.sleep(20);
    await sampleQueueClusters(ctx);
    expect(seen[1]).toEqual({ emails: '5-0' });
    const ov = await studioOverview(ctx, { stack: 'shop', cluster: 'jobs', prefix: 'bull' });
    expect(ov.queues[0]!.rate).toMatchObject({ completed: 6, failed: 2, failureRatio: 0.25 });
  });
});
