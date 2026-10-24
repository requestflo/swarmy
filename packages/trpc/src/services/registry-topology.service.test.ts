import { describe, expect, it } from 'bun:test';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { REGISTRY_AUTH_LABEL } from './registry-auth';
import { convergeRegistryTopologyAllOrgs, convergeRegistryTopologyForOrg } from './registry-topology.service';
import { seedKv } from './swarm-kv.service';

type Spec = { name: string; ports?: unknown[]; networks?: string[]; placement?: unknown; env?: Record<string, string> };
const swarmy = [{ name: 'swarmy', aliases: [] }];
const onMesh = (published: number, networks = swarmy) => ({ ports: [{ target: 5000, published, protocol: 'tcp' }], networks });

/** Two ready nodes (mgr, n2); the registry task runs on n2. `apply` mirrors a deploy into the live inventory. */
function fakes(opts: { forwarders?: Array<'on' | 'off' | undefined>; registry?: object; cache?: object; readOnly?: boolean; apply?: boolean } = {}) {
  const [f1, f2] = opts.forwarders ?? ['on', 'on'];
  const deploys: Spec[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const registry = {
    id: 'svc-reg',
    name: 'swarmy-registry',
    image: 'registry:2@sha256:feed',
    labels: { [REGISTRY_AUTH_LABEL]: 'swarmy-registry-htpasswd-x', 'swarmy.mirror.node': 'swarmn2' },
    env: ['REGISTRY_AUTH=htpasswd', ...(opts.readOnly ? ['REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}'] : [])],
    mounts: [{ type: 'volume', source: 'swarmy-registry-data', target: '/var/lib/registry' }],
    ...(opts.registry ?? onMesh(5000)),
  };
  const cache = { id: 'svc-cache', name: 'swarmy-registry-cache', image: 'registry:2', labels: { 'swarmy.registry.cache.auth': '' }, env: [], ...(opts.cache ?? onMesh(5001, [])) };
  const services: Array<Record<string, unknown>> = [registry, cache];
  const task = { id: 'c-reg', serviceId: 'svc-reg', state: 'running', image: registry.image, labels: { 'com.docker.swarm.node.id': 'swarmn2' } };
  const hub = {
    liveInventory: () => ({ services, containers: [task] }),
    nodeInventory: () => [{ swarmNodeId: 'swarmn1', status: 'ready' }, { swarmNodeId: 'swarmn2', status: 'ready' }],
    onlineNodeIds: () => ['mgr', 'n2'],
    swarmNodeIdFor: (id: string) => (id === 'mgr' ? 'swarmn1' : 'swarmn2'),
    agentBuildFor: (id: string) => ({ version: '1', registryForwarder: id === 'mgr' ? f1 : f2 }),
    managerNode: () => 'mgr',
    latestContainers: (n: string) => (n === 'n2' ? [task] : []),
    lastKnownServices: () => [],
    dispatch: async (_node: string, cmd: string, p: { spec: Spec }) => {
      if (cmd !== 'service.deploy') throw new Error(`unexpected ${cmd}`);
      deploys.push(p.spec);
      if (opts.apply) {
        const i = services.findIndex((s) => s.name === p.spec.name);
        services[i] = { ...services[i], ports: p.spec.ports ?? [], networks: (p.spec.networks ?? []).map((name) => ({ name, aliases: [] })) };
      }
      return {};
    },
  } as unknown as AgentHub;
  const db = {
    organization: { findMany: async () => [{ id: 'o1' }] },
    auditLog: { create: async (a: { data: Record<string, unknown> }) => void audits.push(a.data) },
  } as unknown as DB;
  seedKv(hub, 'o1', 'registry', 'o1', { enabled: true, host: 'localhost:5000', credentialsEnc: null, cacheUsername: null, cacheSecret: null });
  return { deps: { db, hub, auth: {} as Auth }, deploys, audits };
}

describe('convergeRegistryTopologyForOrg (M16 migration)', () => {
  it('holds a cluster on the mesh while any ready node lacks a forwarder', async () => {
    for (const forwarders of [['on', undefined], ['on', 'off']] as const) {
      const f = fakes({ forwarders: [...forwarders] });
      const r = await convergeRegistryTopologyForOrg(f.deps, 'o1');
      expect(r).toMatchObject({ topology: 'mesh', moved: [] });
      expect(f.deploys).toEqual([]);
    }
  });

  it('moves the registry (pinned to its volume node, stop-first) and the cache once every node forwards', async () => {
    const f = fakes();
    const r = await convergeRegistryTopologyForOrg(f.deps, 'o1');
    expect(r).toMatchObject({ topology: 'loopback', moved: ['registry', 'cache'] });
    const [reg, cache] = f.deploys;
    expect(reg).toMatchObject({ name: 'swarmy-registry', ports: [], networks: ['swarmy'], placement: { constraints: ['node.id==swarmn2'] } });
    expect(reg?.env).not.toHaveProperty('REGISTRY_STORAGE_MAINTENANCE_READONLY');
    expect(cache).toMatchObject({ name: 'swarmy-registry-cache', ports: [], networks: ['swarmy'] });
    expect(f.audits[0]).toMatchObject({ action: 'cicd.registry.topology', actorType: 'system' });
  });

  it('is signature-gated: no re-send while the hub catches up, nothing at all once moved', async () => {
    const f = fakes({ apply: false });
    const first = await convergeRegistryTopologyForOrg(f.deps, 'o1');
    const again = await convergeRegistryTopologyForOrg(f.deps, 'o1', first.signature);
    expect(again.skipped).toBe('unchanged');
    expect(f.deploys).toHaveLength(2);

    const g = fakes({ apply: true });
    const moved = await convergeRegistryTopologyForOrg(g.deps, 'o1');
    const steady = await convergeRegistryTopologyForOrg(g.deps, 'o1', moved.signature);
    expect(steady).toMatchObject({ topology: 'loopback', moved: [] });
    expect(steady.signature).not.toBe(moved.signature);
    expect(await convergeRegistryTopologyForOrg(g.deps, 'o1', steady.signature)).toMatchObject({ skipped: 'unchanged' });
    expect(g.deploys).toHaveLength(2);
  });

  it('never moves back, and finishes a half-done move even if a node lost its forwarder since', async () => {
    const f = fakes({ forwarders: ['on', undefined], registry: { ports: [], networks: swarmy } });
    const r = await convergeRegistryTopologyForOrg(f.deps, 'o1');
    expect(r).toMatchObject({ topology: 'loopback', moved: ['cache'] });
    expect(f.deploys.map((d) => d.name)).toEqual(['swarmy-registry-cache']);
  });

  it('leaves a GC window alone and stores no signature, so the next tick retries', async () => {
    const f = fakes({ readOnly: true });
    const r = await convergeRegistryTopologyForOrg(f.deps, 'o1');
    expect(r.skipped).toContain('GC window');
    expect(r.signature).toBeUndefined();
    expect(f.deploys).toEqual([]);
  });
});

describe('convergeRegistryTopologyAllOrgs', () => {
  it('remembers each org signature; force re-checks a move Docker never applied', async () => {
    const f = fakes({ apply: false });
    const state = new Map<string, string>();
    await convergeRegistryTopologyAllOrgs(f.deps, state);
    expect(state.get('o1')).toBe('loopback|registry=mesh|cache=mesh');
    await convergeRegistryTopologyAllOrgs(f.deps, state);
    expect(f.deploys).toHaveLength(2);
    await convergeRegistryTopologyAllOrgs(f.deps, state, { force: true });
    expect(f.deploys).toHaveLength(4);
  });
});
