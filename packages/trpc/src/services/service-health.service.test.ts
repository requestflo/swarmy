import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { serviceHealthProbes, testServiceHealthcheck } from './service-health.service';

const SVC: SwarmServiceInfo = {
  id: 'svc-web',
  name: 'storefront_web',
  image: 'web:1',
  mode: 'replicated',
  desiredReplicas: 2,
  runningReplicas: 2,
  createdAt: 0,
  updatedAt: 0,
  labels: {},
  networks: [],
  env: [],
  ports: [],
  secrets: [],
  configs: [],
};

const ctr = (id: string, createdAt: number, extra: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id,
  name: id,
  image: 'web:1',
  state: 'running',
  status: 'Up (healthy)',
  createdAt,
  ports: [],
  labels: {},
  serviceId: 'svc-web',
  ...extra,
});

const PROBE = { at: 1, durationMs: 4, exitCode: 0 };

interface Opts {
  healthcheck?: unknown;
  exec?: (payload: Record<string, unknown>) => unknown;
  nodeLabels?: Record<string, string>;
  containers?: Record<string, ContainerInfo[]>;
}

function mockCtx(o: Opts = {}) {
  const dispatched: { node: string; cmd: string; payload: Record<string, unknown> }[] = [];
  const audits: Record<string, unknown>[] = [];
  const byNode = o.containers ?? {
    n1: [ctr('old', 1, { health: { status: 'healthy', failingStreak: 0, probes: [PROBE] } })],
    n2: [ctr('new', 2, { health: { status: 'unhealthy', failingStreak: 2, test: ['CMD', 'img-check'], probes: [PROBE, { ...PROBE, exitCode: 1 }] } })],
  };
  const all = Object.values(byNode).flat();
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => audits.push(data) } },
    hub: {
      liveInventory: () => ({ services: [SVC], containers: all }),
      onlineNodeIds: () => Object.keys(byNode),
      latestContainers: (n: string) => byNode[n] ?? [],
      nodeInfoFor: (n: string) => ({ hostname: `host-${n}`, labels: o.nodeLabels ?? {} }),
      agentBuildFor: () => undefined,
      isOnline: () => true,
      managerNode: () => 'n1',
      dispatch: async (node: string, cmd: string, payload: Record<string, unknown>) => {
        dispatched.push({ node, cmd, payload });
        if (cmd === 'service.inspect') {
          return { inspect: { Spec: { Name: SVC.name, TaskTemplate: { ContainerSpec: { Image: 'web:1', Healthcheck: o.healthcheck } } } } };
        }
        return o.exec ? o.exec(payload) : { exitCode: 0, output: 'ok\n', durationMs: 3.2 };
      },
    },
  } as unknown as OrgContext;
  return { ctx, dispatched, audits };
}

describe('serviceHealthProbes — Docker’s record, off the snapshots', () => {
  it('returns each running copy’s probes, newest copy first, with the effective test', () => {
    const { ctx, dispatched } = mockCtx();
    const v = serviceHealthProbes(ctx, 'svc-web');
    expect(v.copies.map((c) => [c.containerId, c.node, c.status, c.probes.length])).toEqual([
      ['new', 'host-n2', 'unhealthy', 2],
      ['old', 'host-n1', 'healthy', 1],
    ]);
    expect(v.test).toEqual(['CMD', 'img-check']);
    expect(dispatched).toEqual([]);
  });

  it('a copy with no record is left out, not shown as healthy', () => {
    const { ctx } = mockCtx({ containers: { n1: [ctr('a', 1)] } });
    expect(serviceHealthProbes(ctx, 'svc-web')).toEqual({ copies: [], test: null });
  });
});

describe('testServiceHealthcheck — once, in the newest copy, on its own node', () => {
  it('execs the spec’s check with its timeout, returns exit code and time, audits', async () => {
    const { ctx, dispatched, audits } = mockCtx({ healthcheck: { Test: ['CMD-SHELL', 'curl -f localhost/h'], Timeout: 3e9 } });
    const r = await testServiceHealthcheck(ctx, 'svc-web');
    const exec = dispatched.find((d) => d.cmd === 'exec')!;
    expect(exec.node).toBe('n2');
    expect(exec.payload).toEqual({ target: { containerId: 'new' }, cmd: ['/bin/sh', '-c', 'curl -f localhost/h'], tty: false, stream: false, timeoutMs: 3000, nodeCapable: true });
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false, durationMs: 3.2, output: 'ok', node: 'host-n2' });
    expect(audits[0]).toMatchObject({ action: 'service.healthcheck.test', targetId: 'svc-web' });
  });

  it('with no check of its own, runs the image’s (from the copy’s record)', async () => {
    const { ctx, dispatched } = mockCtx();
    await testServiceHealthcheck(ctx, 'svc-web');
    expect(dispatched.find((d) => d.cmd === 'exec')?.payload.cmd).toEqual(['img-check']);
  });

  it('a timeout is a result, not an error', async () => {
    const { ctx } = mockCtx({ healthcheck: { Test: ['CMD', 'slow'] }, exec: () => Promise.reject(new Error('exec timed out after 30s')) });
    expect(await testServiceHealthcheck(ctx, 'svc-web')).toMatchObject({ ok: false, exitCode: null, timedOut: true, durationMs: 30_000 });
  });

  it('refuses when the check is off, or exec is off for that server', async () => {
    await expect(testServiceHealthcheck(mockCtx({ healthcheck: { Test: ['NONE'] } }).ctx, 'svc-web')).rejects.toThrow(/switched off/);
    const off = mockCtx({ healthcheck: { Test: ['CMD', 'x'] }, nodeLabels: { 'swarmy.node.exec': 'false' } });
    await expect(testServiceHealthcheck(off.ctx, 'svc-web')).rejects.toThrow(/exec is turned off/);
    expect(off.dispatched.some((d) => d.cmd === 'exec')).toBe(false);
  });
});
