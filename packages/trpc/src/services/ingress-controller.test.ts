import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  EDGE_START_GRACE_MS,
  caddyControllerSpec,
  deriveEdgeRuntime,
  ensureCaddyController,
  ingressPlacementConstraint,
  type ResolvedOptions,
} from './ingress-controller';
import { edgeRuntimeStatus, reconcileIngressOrg } from './ingress.service';
import { seedKv, useMemoryKv } from './swarm-kv.service';

// Real-shaped ids from the readiness sweep: swarmy's DB cuid vs Docker's swarm node id.
const ENROLLMENT_ID = 'cmrfodzd9001i4vsb0pafd656';
const SWARM_NODE_ID = 'zz40tjnscsjyi8ixql4zxcs5q';

function placement(over: Partial<Parameters<typeof ingressPlacementConstraint>[0]> = {}) {
  return ingressPlacementConstraint({
    targetNodes: [],
    swarmNodeIdFor: (id) => (id === ENROLLMENT_ID ? SWARM_NODE_ID : undefined),
    knownSwarmNodeIds: new Set([SWARM_NODE_ID]),
    anyIngressLabelled: false,
    ...over,
  });
}

describe('ingressPlacementConstraint — root cause #4 (wrong node-id namespace)', () => {
  it('pins a single target via the DOCKER swarm node id, never the swarmy enrollment id', () => {
    const c = placement({ targetNodes: [ENROLLMENT_ID] });
    expect(c).toBe(`node.id==${SWARM_NODE_ID}`);
    expect(c).not.toContain(ENROLLMENT_ID);
  });

  it('accepts a legacy pin that is already a swarm node id', () => {
    expect(
      placement({ targetNodes: [SWARM_NODE_ID], swarmNodeIdFor: () => undefined }),
    ).toBe(`node.id==${SWARM_NODE_ID}`);
  });

  it('an unresolvable pin never emits an unsatisfiable node.id constraint', () => {
    expect(placement({ targetNodes: ['cm_stale_node'] })).toBe('node.role == manager');
    expect(placement({ targetNodes: ['cm_stale_node'], anyIngressLabelled: true })).toBe(
      'node.labels.swarmy.node.ingress==true',
    );
  });

  it('multiple pins use the ingress label tier; nothing marked falls back to managers', () => {
    expect(placement({ targetNodes: ['a', 'b'], anyIngressLabelled: true })).toBe(
      'node.labels.swarmy.node.ingress==true',
    );
    expect(placement()).toBe('node.role == manager');
  });
});

const OPTS: ResolvedOptions = {
  network: 'swarmy',
  image: 'caddy:2-alpine',
  replicas: 1,
  publishAdmin: false,
  adminOnOverlay: false,
  targetNodes: [],
};

describe('caddyControllerSpec — golden', () => {
  const spec = caddyControllerSpec(OPTS, `node.id==${SWARM_NODE_ID}`);

  it('joins the fronted-apps network + swarmy + the PRIVATE swarmy-control (controller upstream)', () => {
    expect(spec.networks).toEqual(['swarmy', 'swarmy-control']);
    expect(caddyControllerSpec({ ...OPTS, network: 'edge' }, 'x').networks).toEqual(['edge', 'swarmy', 'swarmy-control']);
  });

  it('carries the resolved placement constraint verbatim', () => {
    expect(spec.placement?.constraints).toEqual([`node.id==${SWARM_NODE_ID}`]);
  });

  it('publishes 80/443 in host mode and does NOT publish the admin API by default', () => {
    expect(spec.ports).toEqual([
      { target: 80, published: 80, protocol: 'tcp', mode: 'host' },
      { target: 443, published: 443, protocol: 'tcp', mode: 'host' },
    ]);
  });

  it('binds the unauthenticated admin API to loopback by default', () => {
    expect(spec.command?.join(' ')).toContain('admin 127.0.0.1:2019');
    const overlay = caddyControllerSpec({ ...OPTS, adminOnOverlay: true }, 'node.role == manager');
    expect(overlay.command?.join(' ')).toContain('admin 0.0.0.0:2019');
  });

  it('resumes the autosaved config across task restarts', () => {
    expect(spec.command?.join(' ')).toContain('--resume');
  });
});

// ── ensureCaddyController end-to-end over a fake hub: the deployed spec ──

interface Dispatched {
  nodeId: string;
  cmd: string;
  payload: unknown;
}

function fakeCtx(opts: {
  nodes?: SwarmNodeInfo[];
  swarmIds?: Record<string, string>;
  services?: SwarmServiceInfo[];
  containers?: Record<string, ContainerInfo[]>;
  ingressRow?: { driver: string; enabled: boolean; settings?: unknown };
}) {
  const sent: Dispatched[] = [];
  const row = {
    driver: opts.ingressRow?.driver ?? 'CADDY',
    enabled: opts.ingressRow?.enabled ?? true,
    settings: opts.ingressRow?.settings ?? {},
    updatedAt: new Date(0),
  };
  const nodeIds = Object.keys(opts.containers ?? { m1: [] });
  const db = {
    node: { findMany: async () => nodeIds.map((id) => ({ id })) },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    managerNodes: () => ['m1'],
    nodeInventory: () => opts.nodes ?? [],
    swarmNodeIdFor: (id: string) => opts.swarmIds?.[id],
    nodeInfoFor: (id: string) => ({ hostname: `host-${id}`, labels: {} }),
    liveInventory: () => ({ services: opts.services ?? [], containers: [] }),
    latestContainers: (id: string) => opts.containers?.[id] ?? [],
    dispatch: async (nodeId: string, cmd: string, payload: unknown) => {
      sent.push({ nodeId, cmd, payload });
      return {};
    },
  };
  const ctx = { db, hub, activeOrgId: 'org_1' } as unknown as OrgContext;
  // The org's ingress config lives in its swarm (swarm-kv).
  useMemoryKv(ctx.hub);
  seedKv(ctx.hub, 'org_1', 'ingress', 'org_1', { driver: row.driver, enabled: row.enabled, settings: row.settings });
  return { ctx, sent, deps: { db, hub, auth: {} } as never };
}

function swarmNode(over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo {
  return {
    swarmNodeId: SWARM_NODE_ID,
    hostname: 'lima-swarmy-fresh-1',
    role: 'manager',
    availability: 'active',
    status: 'ready',
    leader: true,
    labels: {},
    ...over,
  };
}

describe('ensureCaddyController — deployed spec', () => {
  it('translates the pinned enrollment id to the swarm node id in the deployed constraint', async () => {
    const { ctx, sent } = fakeCtx({
      nodes: [swarmNode()],
      swarmIds: { [ENROLLMENT_ID]: SWARM_NODE_ID },
    });
    await ensureCaddyController(ctx, { targetNodes: [ENROLLMENT_ID] });
    const deploy = sent.find((d) => d.cmd === 'service.deploy');
    const spec = (deploy?.payload as { spec: { placement: { constraints: string[] } } }).spec;
    expect(spec.placement.constraints).toEqual([`node.id==${SWARM_NODE_ID}`]);
  });
});

// ── runtime truth — root cause #1 (badge from config, not reality) ──

function caddySvc(over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo {
  return {
    id: 'svc1',
    name: 'swarmy-ingress-caddy',
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

function caddyTask(id = 'c1'): ContainerInfo {
  return {
    id,
    name: `swarmy-ingress-caddy.1.${id}`,
    image: 'caddy:2-alpine',
    state: 'running',
    status: 'Up',
    createdAt: 0,
    ports: [],
    labels: { 'com.docker.swarm.service.name': 'swarmy-ingress-caddy' },
  };
}

describe('deriveEdgeRuntime', () => {
  const now = 10 * EDGE_START_GRACE_MS;
  const ok = { ok: true, at: 'x', message: 'applied to 1 node(s)' };

  it('driver none is tracking-only, never serving', () => {
    const r = deriveEdgeRuntime({ driver: 'none', enabled: true, taskHosts: [], now });
    expect(r.state).toBe('tracking');
    expect(r.serving).toBe(false);
  });

  it('caddy enabled but not deployed is DOWN (the old "Caddy · live" lie)', () => {
    const r = deriveEdgeRuntime({ driver: 'caddy', enabled: true, taskHosts: [], lastApply: ok, now });
    expect(r.state).toBe('down');
    expect(r.serving).toBe(false);
  });

  it('0/1 tasks past the start grace is DOWN (unschedulable controller)', () => {
    const r = deriveEdgeRuntime({
      driver: 'caddy',
      enabled: true,
      service: { runningReplicas: 0, desiredReplicas: 1, mode: 'replicated', updatedAt: 0 },
      taskHosts: [],
      now,
    });
    expect(r.state).toBe('down');
    expect(r.message).toContain('docker service ps');
  });

  it('0/1 tasks inside the grace window is deploying', () => {
    const r = deriveEdgeRuntime({
      driver: 'caddy',
      enabled: true,
      service: { runningReplicas: 0, desiredReplicas: 1, mode: 'replicated', updatedAt: now - 1000 },
      taskHosts: [],
      now,
    });
    expect(r.state).toBe('deploying');
  });

  it('running but last apply failed is degraded; running + applied is serving', () => {
    const service = { runningReplicas: 1, desiredReplicas: 1, mode: 'replicated' as const };
    const bad = deriveEdgeRuntime({
      driver: 'caddy',
      enabled: true,
      service,
      taskHosts: ['n1'],
      lastApply: { ok: false, at: 'x', message: 'caddy exited 1' },
      now,
    });
    expect(bad.state).toBe('degraded');
    expect(bad.message).toContain('caddy exited 1');
    const good = deriveEdgeRuntime({ driver: 'caddy', enabled: true, service, taskHosts: ['n1'], lastApply: ok, now });
    expect(good.state).toBe('serving');
    expect(good.serving).toBe(true);
  });

  it('bring-your-own drivers are unverified, never serving', () => {
    const r = deriveEdgeRuntime({ driver: 'traefik', enabled: true, taskHosts: [], lastApply: ok, now });
    expect(r.state).toBe('unverified');
    expect(r.serving).toBe(false);
  });
});

// ── reconcile: routes get applied into the running controller task, gated ──

describe('reconcileIngressOrg', () => {
  const routeLabels = {
    'swarmy.ingress.routes': JSON.stringify([{ host: 'littleworld.example.test', port: 80, tls: 'auto' }]),
  };
  const app = caddySvc({ id: 'app1', name: 'littleworld_site', labels: routeLabels });

  it('re-deploys a missing controller when Caddy is enabled', async () => {
    const { deps, sent } = fakeCtx({ services: [app], containers: { m1: [] } });
    const res = await reconcileIngressOrg(deps, 'org_rc_missing');
    expect(res.signature).toBeNull();
    expect(sent.some((d) => d.cmd === 'service.deploy')).toBe(true);
  });

  it('exec-applies into the node hosting the task, then goes quiet at steady state', async () => {
    const { deps, sent } = fakeCtx({
      services: [app, caddySvc()],
      containers: { m1: [], n2: [caddyTask()] },
    });
    const first = await reconcileIngressOrg(deps, 'org_rc_apply');
    expect(first.applied).toBe(true);
    const apply = sent.filter((d) => d.cmd === 'applyIngress');
    expect(apply.map((d) => d.nodeId)).toEqual(['n2']);
    const rendered = (apply[0]!.payload as { rendered: Record<string, any> }).rendered;
    expect(rendered.files).toEqual([]);
    expect(rendered.localReload.service).toBe('swarmy-ingress-caddy');
    expect(rendered.localReload.file.contents).toContain('littleworld.example.test');

    const second = await reconcileIngressOrg(deps, 'org_rc_apply', first.signature);
    expect(second.skipped).toBe(true);
    expect(sent.filter((d) => d.cmd === 'applyIngress')).toHaveLength(1);
  });

  it('a rescheduled task (new container id) re-triggers the push', async () => {
    const a = fakeCtx({ services: [app, caddySvc()], containers: { n2: [caddyTask('c1')] } });
    const first = await reconcileIngressOrg(a.deps, 'org_rc_resched');
    const b = fakeCtx({ services: [app, caddySvc()], containers: { n2: [caddyTask('c2')] } });
    const second = await reconcileIngressOrg(b.deps, 'org_rc_resched', first.signature);
    expect(second.applied).toBe(true);
  });

  it('runtime reads serving only after a successful apply', async () => {
    const { ctx, deps } = fakeCtx({ services: [app, caddySvc()], containers: { n2: [caddyTask()] } });
    const orgCtx = { ...ctx, activeOrgId: 'org_rc_runtime' } as OrgContext;
    expect((await edgeRuntimeStatus(orgCtx)).state).toBe('deploying');
    await reconcileIngressOrg(deps, 'org_rc_runtime');
    const after = await edgeRuntimeStatus(orgCtx);
    expect(after.state).toBe('serving');
    expect(after.message).toContain('host-n2');
  });
});
