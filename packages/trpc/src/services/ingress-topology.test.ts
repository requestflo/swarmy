import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, ServiceSpec, SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { caddyEdgeSpec, deployWithModeSwap, EDGE_PLACEMENT_CONSTRAINT } from './ingress-controller';
import { reconcileIngressOrg, setTopology } from './ingress.service';

/**
 * Geo-edge topology swap: swarm can't flip replicated↔global in place
 * (`HTTP 501 service mode change is not allowed`), so the swap is remove +
 * create with the cert volumes kept, and the setting persists only on success.
 */

const EDGE_NAME = 'swarmy-ingress-caddy';

interface Sent {
  nodeId: string;
  cmd: string;
  payload: any;
}

function svc(over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo {
  return {
    id: 'svc1',
    name: EDGE_NAME,
    image: 'caddy:2-alpine',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: {},
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    ...over,
  };
}

function edgeTask(id: string): ContainerInfo {
  return {
    id,
    name: `${EDGE_NAME}.x.${id}`,
    image: 'caddy:2-alpine',
    state: 'running',
    status: 'Up',
    createdAt: 0,
    ports: [],
    labels: { 'com.docker.swarm.service.name': EDGE_NAME },
  };
}

function node(over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo {
  return {
    swarmNodeId: 'sw1',
    hostname: 'lon-a',
    role: 'manager',
    availability: 'active',
    status: 'ready',
    leader: true,
    labels: { 'swarmy.node.ingress': 'true' },
    ...over,
  };
}

/**
 * Stateful fake: `service.remove`/`service.deploy` mutate the live inventory
 * the way Docker would — including REFUSING an in-place mode change.
 */
function world(opts: {
  services?: SwarmServiceInfo[];
  settings?: Record<string, unknown>;
  nodes?: SwarmNodeInfo[];
  containers?: Record<string, ContainerInfo[]>;
  failDeployOf?: 'global' | 'replicated';
  /** Inventory lies: reports this mode while Docker holds the other. */
  staleMode?: 'replicated' | 'global';
}) {
  const sent: Sent[] = [];
  const services = [...(opts.services ?? [])];
  const truthMode = new Map(services.map((s) => [s.name, s.mode]));
  const row = { driver: 'CADDY', enabled: true, settings: { ...(opts.settings ?? {}) } as any, updatedAt: new Date(0) };
  const updates: unknown[] = [];
  const containers = opts.containers ?? { m1: [] };
  const db = {
    observabilityConfig: { findUnique: async () => null },
    ingressConfig: {
      upsert: async () => row,
      update: async (a: { data: { settings: unknown } }) => {
        updates.push(a.data.settings);
        row.settings = a.data.settings;
        return row;
      },
    },
    node: { findMany: async () => Object.keys(containers).map((id) => ({ id })) },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    auditLog: { create: async () => ({}) },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    managerNodes: () => ['m1'],
    nodeInventory: () => opts.nodes ?? [node()],
    swarmNodeIdFor: () => undefined,
    nodeInfoFor: (id: string) => ({ hostname: `host-${id}`, labels: {} }),
    liveInventory: () => ({
      services: services.map((s) => (opts.staleMode ? { ...s, mode: opts.staleMode } : s)),
      containers: [],
    }),
    latestContainers: (id: string) => containers[id] ?? [],
    dispatch: async (nodeId: string, cmd: string, payload: any) => {
      sent.push({ nodeId, cmd, payload });
      if (cmd === 'service.remove') {
        const i = services.findIndex((s) => s.name === payload.service);
        if (i < 0) throw new Error(`service ${payload.service} not found`);
        services.splice(i, 1);
        truthMode.delete(payload.service);
      }
      if (cmd === 'service.deploy') {
        const spec = payload.spec as ServiceSpec;
        const mode = spec.mode && 'global' in spec.mode ? 'global' : 'replicated';
        if (opts.failDeployOf === mode) throw new Error('image pull failed');
        const live = truthMode.get(spec.name);
        if (live && live !== mode) {
          throw new Error('(HTTP code 501) unexpected - service mode change is not allowed');
        }
        truthMode.set(spec.name, mode);
        const i = services.findIndex((s) => s.name === spec.name);
        const next = svc({ name: spec.name, mode, labels: spec.labels ?? {} });
        if (i >= 0) services[i] = next;
        else services.push(next);
      }
      return {};
    },
  };
  const ctx = { db, hub, activeOrgId: 'org_topo', user: { id: 'u1' } } as unknown as OrgContext;
  return { ctx, sent, row, updates, services, deps: { db, hub, auth: {} } as never };
}

const cmds = (sent: Sent[]) => sent.map((s) => s.cmd).filter((c) => c.startsWith('service.'));

describe('caddyEdgeSpec — edge-per-node golden', () => {
  const spec = caddyEdgeSpec({ network: 'swarmy', image: 'caddy:2-alpine' });

  it('runs GLOBAL on ingress-labelled nodes', () => {
    expect(spec.mode).toEqual({ global: {} });
    expect(spec.placement?.constraints).toEqual([EDGE_PLACEMENT_CONSTRAINT]);
    expect(EDGE_PLACEMENT_CONSTRAINT).toBe('node.labels.swarmy.node.ingress == true');
  });

  it('joins the swarmy overlay (dashboard vhost upstream) even on a custom org network', () => {
    expect(spec.networks).toEqual(['swarmy']);
    expect(caddyEdgeSpec({ network: 'edge', image: 'x' }).networks).toEqual(['edge', 'swarmy']);
  });

  it('has NO host bind mount — config is written inside the task — and keeps the cert volumes', () => {
    expect(spec.mounts?.some((m) => m.type === 'bind')).toBe(false);
    expect(spec.mounts).toEqual([
      { type: 'volume', source: 'swarmy-ingress-caddy-data', target: '/data' },
      { type: 'volume', source: 'swarmy-ingress-caddy-config', target: '/config' },
    ]);
  });

  it('boots a loopback-admin base config and resumes the autosave; host-mode 80/443', () => {
    const cmd = spec.command?.join(' ') ?? '';
    expect(cmd).toContain('admin 127.0.0.1:2019');
    expect(cmd).toContain('--resume');
    expect(spec.ports?.every((p) => p.mode === 'host')).toBe(true);
    expect(spec.ports?.map((p) => p.published)).toEqual([80, 443, 443]);
  });
});

describe('deployWithModeSwap', () => {
  it('replicated → global: removes the live service (by `service`, not `name`) then creates', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })] });
    const swapped = await deployWithModeSwap(w.ctx, 'm1', caddyEdgeSpec({ network: 'swarmy', image: 'i' }));
    expect(swapped).toBe(true);
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    expect(w.sent[0]!.payload).toEqual({ service: EDGE_NAME });
    expect(w.services[0]!.mode).toBe('global');
  });

  it('same mode is a plain in-place update (no remove)', async () => {
    const w = world({ services: [svc({ mode: 'global' })] });
    expect(await deployWithModeSwap(w.ctx, 'm1', caddyEdgeSpec({ network: 'swarmy', image: 'i' }))).toBe(false);
    expect(cmds(w.sent)).toEqual(['service.deploy']);
  });

  it('stale inventory: Docker refuses the mode change → remove + create once', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })], staleMode: 'global' });
    expect(await deployWithModeSwap(w.ctx, 'm1', caddyEdgeSpec({ network: 'swarmy', image: 'i' }))).toBe(true);
    expect(cmds(w.sent)).toEqual(['service.deploy', 'service.remove', 'service.deploy']);
  });
});

describe('setTopology', () => {
  it('controller → edge-per-node swaps the service and persists only after the deploy', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })] });
    const view = await setTopology(w.ctx, 'edge-per-node');
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    const deployed = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(deployed.mode).toEqual({ global: {} });
    // Volumes are named volumes carried by the new spec — never removed.
    expect(deployed.mounts?.map((m) => m.source)).toEqual([
      'swarmy-ingress-caddy-data',
      'swarmy-ingress-caddy-config',
    ]);
    expect(w.sent.some((s) => s.cmd.startsWith('volume.'))).toBe(false);
    expect(w.row.settings.topology).toBe('edge-per-node');
    expect(view.topology).toBe('edge-per-node');
  });

  it('edge-per-node → controller swaps back', async () => {
    const w = world({ services: [svc({ mode: 'global' })], settings: { topology: 'edge-per-node' } });
    await setTopology(w.ctx, 'controller');
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    expect(w.services[0]!.mode).toBe('replicated');
    expect(w.row.settings.topology).toBe('controller');
  });

  it('a failed deploy does NOT persist the setting and restores the previous topology', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })], failDeployOf: 'global' });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow();
    expect(w.updates).toEqual([]);
    expect(w.row.settings.topology).toBeUndefined();
    // removed, failed create, rolled back to the replicated controller
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy', 'service.deploy']);
    expect(w.services.map((s) => s.mode)).toEqual(['replicated']);
  });

  it('refuses edge-per-node when no node is ingress-labelled — nothing touched', async () => {
    const w = world({ services: [svc()], nodes: [node({ labels: {} })] });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow(/ingress node/);
    expect(cmds(w.sent)).toEqual([]);
    expect(w.updates).toEqual([]);
  });

  it('refuses when the config would not validate under the new topology (HA storage + stock image)', async () => {
    const w = world({
      services: [svc()],
      settings: { haStorage: { host: 'redis', port: 6379 } },
    });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow(/caddy-storage-redis/);
    expect(cmds(w.sent)).toEqual([]);
    expect(w.updates).toEqual([]);
  });
});

describe('reconcileIngressOrg — edge-per-node', () => {
  const app = svc({
    id: 'app1',
    name: 'web',
    labels: {
      'swarmy.ingress.routes': JSON.stringify([{ host: 'app.example.test', port: 80, tls: 'auto' }]),
    },
  });

  it('converges a live mode that disagrees with the persisted topology', async () => {
    const w = world({ services: [app, svc({ mode: 'replicated' })], settings: { topology: 'edge-per-node' } });
    const res = await reconcileIngressOrg(w.deps, 'org_topo_drift');
    expect(res.signature).toBeNull();
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    expect(w.services.find((s) => s.name === EDGE_NAME)!.mode).toBe('global');
  });

  it('exec-delivers the config into EVERY node running an edge task — no host files', async () => {
    const w = world({
      services: [app, svc({ mode: 'global' })],
      settings: { topology: 'edge-per-node' },
      containers: { lon: [edgeTask('c-lon')], nyc: [edgeTask('c-nyc')], worker: [] },
    });
    const res = await reconcileIngressOrg(w.deps, 'org_topo_fanout');
    expect(res.applied).toBe(true);
    const applies = w.sent.filter((s) => s.cmd === 'applyIngress');
    expect(applies.map((a) => a.nodeId).sort()).toEqual(['lon', 'nyc']);
    for (const a of applies) {
      expect(a.payload.rendered.files).toEqual([]);
      expect(a.payload.rendered.localReload.service).toBe(EDGE_NAME);
      expect(a.payload.rendered.localReload.file.path).toBe('/etc/caddy/Caddyfile');
      expect(a.payload.rendered.localReload.file.contents).toContain('app.example.test');
    }
  });
});
