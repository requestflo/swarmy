import { describe, expect, it } from 'bun:test';
import { CACHE_PIN_NODE_LABEL, STACK_LABEL } from '@swarmy/core';
import type { ContainerInfo, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { dataVolumeNode, reconcileDataPin, type DataPinSeams } from './data-pin';

/**
 * The live bug: `hello_main-cache` (valkey, data on the node-local volume
 * `hello_main-cache-data`) floated; a reboot rescheduled it onto another node
 * with a fresh EMPTY volume. These cover the reconcile step that pins it.
 */
const SERVICE = 'hello_main-cache';
const VOLUME = 'hello_main-cache-data';

function primary(labels: Record<string, string> = {}): SwarmServiceInfo {
  return {
    id: 'svc-cache',
    name: SERVICE,
    image: 'valkey/valkey:8',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 1,
    updatedAt: 1,
    labels: {
      [STACK_LABEL]: 'hello',
      'swarmy.cache.engine': 'valkey',
      'swarmy.cache.cluster': 'main',
      'swarmy.cache.role': 'primary',
      'swarmy.backup.retentionDays': '7', // a foreign label that must survive
      ...labels,
    },
    networks: [{ name: 'hello_main-cache-net', aliases: [] }],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    mounts: [{ type: 'volume', source: VOLUME, target: '/data' }],
  };
}

function running(serviceId: string): ContainerInfo {
  return {
    id: `c-${serviceId}`,
    name: `c-${serviceId}`,
    image: 'valkey/valkey:8',
    state: 'running',
    status: 'Up',
    createdAt: 1,
    ports: [],
    labels: { 'com.docker.swarm.service.id': serviceId },
    serviceId,
  } as ContainerInfo;
}

/** `docker service inspect` of the live (unpinned) primary. */
function inspectOf(svc: SwarmServiceInfo) {
  return {
    Spec: {
      Name: svc.name,
      Labels: svc.labels,
      Mode: { Replicated: { Replicas: 1 } },
      TaskTemplate: {
        ContainerSpec: {
          Image: svc.image,
          Command: ['sh', '-c'],
          Args: ['exec valkey-server --dir /data'],
          Mounts: [{ Type: 'volume', Source: VOLUME, Target: '/data' }],
          Secrets: [{ SecretName: 'swarmy-cache-hello_main-password', File: { Name: 'cache-password' } }],
        },
        Placement: { Preferences: [{ Spread: { SpreadDescriptor: 'node.id' } }] },
      },
    },
  };
}

function harness(svc: SwarmServiceInfo, containers: Record<string, ContainerInfo[]>) {
  const calls: { nodeId: string; cmd: string; payload: Record<string, unknown> }[] = [];
  const events: { severity: string; message: string; status?: string; signal: string }[] = [];
  const audits: unknown[] = [];
  const hub = {
    liveInventory: () => ({ services: [svc], containers: Object.values(containers).flat() }),
    onlineNodeIds: () => ['node-a', 'node-b', 'node-c'],
    latestContainers: (nodeId: string) => containers[nodeId] ?? [],
    swarmNodeIdFor: (nodeId: string) => `swarm-${nodeId}`,
    dispatch: async (nodeId: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ nodeId, cmd, payload });
      if (cmd === 'service.inspect') return { inspect: inspectOf(svc) };
      return {};
    },
  };
  const ctx = { activeOrgId: 'org1', user: null, hub, db: {} } as unknown as OrgContext;
  const seams: DataPinSeams = {
    fireEvent: async (_ctx, e) => {
      events.push(e);
    },
    writeAudit: async (_ctx, entry) => {
      audits.push(entry);
    },
  };
  return { ctx, calls, events, audits, seams };
}

const step = (h: ReturnType<typeof harness>, member: SwarmServiceInfo, warned = new Set<string>()) =>
  reconcileDataPin({
    ctx: h.ctx,
    managerNodeId: 'node-a',
    member,
    pinLabel: CACHE_PIN_NODE_LABEL,
    resource: 'cache:hello/main',
    title: 'Cache hello/main',
    volume: VOLUME,
    warned,
    seams: h.seams,
  });

describe('reconcileDataPin — adopt in place', () => {
  it('pins an unpinned RUNNING primary to the node its task is on, keeping the full live spec', async () => {
    const svc = primary();
    // The task runs on node-b — that is where its data volume is.
    const h = harness(svc, { 'node-b': [running(svc.id)] });
    const out = await step(h, svc);
    expect(out).toEqual({ kind: 'adopt', pin: 'swarm-node-b', adopted: true });

    const deploys = h.calls.filter((c) => c.cmd === 'service.deploy');
    expect(deploys).toHaveLength(1);
    const spec = deploys[0]!.payload.spec as ServiceSpec;
    expect(spec.placement).toEqual({
      constraints: ['node.id==swarm-node-b'],
      preferences: ['spread=node.id'],
      maxReplicasPerNode: 1,
    });
    expect(spec.labels?.[CACHE_PIN_NODE_LABEL]).toBe('swarm-node-b');
    // In place: same volume, command, secret and foreign labels — no data move.
    expect(spec.mounts).toEqual([{ type: 'volume', source: VOLUME, target: '/data' }]);
    expect(spec.args).toEqual(['exec valkey-server --dir /data']);
    expect(spec.secrets).toEqual([{ source: 'swarmy-cache-hello_main-password', target: 'cache-password' }]);
    expect(spec.labels?.['swarmy.backup.retentionDays']).toBe('7');
    expect(spec.networks).toEqual(['hello_main-cache-net']);
    expect(h.audits).toHaveLength(1);
    expect(h.events.map((e) => e.signal)).toEqual(['data-storage-pinned']);
  });

  it('a pinned primary dispatches nothing (steady state)', async () => {
    const svc = primary({ [CACHE_PIN_NODE_LABEL]: 'swarm-node-b' });
    const h = harness(svc, { 'node-b': [running(svc.id)] });
    expect(await step(h, svc)).toEqual({ kind: 'pinned', pin: 'swarm-node-b' });
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe('reconcileDataPin — no running task → warning, never a redeploy', () => {
  it('warns once and dispatches nothing', async () => {
    const svc = { ...primary(), runningReplicas: 0 };
    const h = harness(svc, {});
    const warned = new Set<string>();
    const first = await step(h, svc, warned);
    expect(first.kind).toBe('unplaced');
    await step(h, svc, warned); // next tick: still unplaced, no duplicate warning
    expect(h.calls).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.severity).toBe('warning');
    expect(h.events[0]!.message).toContain('no task is running');
  });

  it('running on several nodes is ambiguous → warning, no dispatch', async () => {
    const svc = primary();
    const h = harness(svc, { 'node-a': [running(svc.id)], 'node-b': [running(svc.id)] });
    const out = await step(h, svc);
    expect(out.kind === 'unplaced' && out.reason).toBe('ambiguous');
    expect(h.calls).toEqual([]);
  });

  it('resolves the warning once it is pinned', async () => {
    const svc = primary();
    const h = harness(svc, { 'node-c': [running(svc.id)] });
    const warned = new Set(['cache:hello/main']);
    await step(h, svc, warned);
    expect(warned.has('cache:hello/main')).toBe(false);
    expect(h.events.find((e) => e.status === 'resolved')).toBeDefined();
  });
});

describe('dataVolumeNode — backup/restore run where the volume is', () => {
  it('pinned → the pinned node, even when a manager would be closer', async () => {
    const svc = primary({ [CACHE_PIN_NODE_LABEL]: 'swarm-node-c' });
    const h = harness(svc, {});
    expect(await dataVolumeNode(h.ctx, svc, CACHE_PIN_NODE_LABEL)).toEqual({
      nodeId: 'node-c',
      pin: 'swarm-node-c',
    });
  });

  it('unpinned + running → that node; with adopt it is pinned there first', async () => {
    const svc = primary();
    const h = harness(svc, { 'node-b': [running(svc.id)] });
    const out = await dataVolumeNode(h.ctx, svc, CACHE_PIN_NODE_LABEL, { adopt: true, managerNodeId: 'node-a' });
    expect(out.nodeId).toBe('node-b');
    const deploy = h.calls.find((c) => c.cmd === 'service.deploy');
    expect((deploy?.payload.spec as ServiceSpec).placement?.constraints).toEqual(['node.id==swarm-node-b']);
  });

  it('unpinned + not running → refused (never a manager with an empty volume)', async () => {
    const svc = primary();
    const h = harness(svc, {});
    await expect(dataVolumeNode(h.ctx, svc, CACHE_PIN_NODE_LABEL)).rejects.toThrow(/no task is running/);
    expect(h.calls).toEqual([]);
  });
});
