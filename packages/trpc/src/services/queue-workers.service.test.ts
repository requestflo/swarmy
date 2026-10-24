import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { connectedWorkers } from './queue-workers.service';

/** A worker consuming `emails` (BullMQ) and `outbox` (raw list) off shop/jobs, over a fake hub. */
const svc = (id: string, name: string, labels: Record<string, string>) => ({
  id,
  name,
  image: 'x',
  mode: 'replicated',
  replicas: 2,
  runningReplicas: 2,
  desiredReplicas: 2,
  labels: { 'com.docker.stack.namespace': 'shop', ...labels },
  networks: [],
  env: [],
  ports: [],
  createdAt: 0,
  updatedAt: 0,
});
const primary = svc('svc-primary', 'shop_jobs-cache', {
  'swarmy.cache.cluster': 'jobs',
  'swarmy.cache.role': 'primary',
  'swarmy.cache.engine': 'valkey',
});
const worker = svc('svc-worker', 'shop_mailer', {
  'swarmy.queues': JSON.stringify([
    { name: 'emails', cacheCluster: 'jobs', convention: 'bullmq' },
    { name: 'outbox', cacheCluster: 'jobs', convention: 'list' },
  ]),
});
const container = { id: 'ctr1', name: 'c', image: 'x', state: 'running', status: 'Up', serviceId: 'svc-primary', labels: {} };

function ctxWith(reply: () => Promise<{ exitCode: number; output: string }>) {
  const sent: { cmd: string; payload: { cmd: string[]; target: { containerId: string } } }[] = [];
  const ctx = {
    activeOrgId: 'org1',
    hub: {
      liveInventory: () => ({ services: [primary, worker], containers: [container] }),
      onlineNodeIds: () => ['node-a'],
      latestContainers: () => [container],
      dispatch: async (_node: string, cmd: string, payload: never) => {
        sent.push({ cmd, payload });
        return reply();
      },
    },
  } as unknown as OrgContext;
  return { ctx, sent };
}

describe('queues.connectedWorkers', () => {
  it('counts BullMQ workers off the cache primary with one exec', async () => {
    const { ctx, sent } = ctxWith(async () => ({ exitCode: 0, output: ' name=bull:ZW1haWxz\n name=bull:ZW1haWxz:w:mailer-2\n' }));
    const v = await connectedWorkers(ctx, { workerService: 'shop_mailer', queue: 'emails' });
    expect(v).toMatchObject({ queue: 'emails', workerService: 'shop_mailer', connected: 2, names: ['mailer-2'], reason: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ cmd: 'exec', payload: { target: { containerId: 'ctr1' } } });
    expect(sent[0]!.payload.cmd.slice(0, 2)).toEqual(['sh', '-c']);
  });

  it('a raw list says it cannot tell, without an exec', async () => {
    const { ctx, sent } = ctxWith(async () => ({ exitCode: 0, output: '' }));
    const v = await connectedWorkers(ctx, { workerService: 'shop_mailer', queue: 'outbox' });
    expect(v).toMatchObject({ connected: null, reason: 'raw-list' });
    expect(sent).toHaveLength(0);
  });

  it('a cache that does not answer is unreachable, never zero', async () => {
    const { ctx } = ctxWith(async () => ({ exitCode: 2, output: 'NOAUTH' }));
    const v = await connectedWorkers(ctx, { workerService: 'shop_mailer', queue: 'emails' });
    expect(v).toMatchObject({ connected: null, reason: 'unreachable' });
  });
});
