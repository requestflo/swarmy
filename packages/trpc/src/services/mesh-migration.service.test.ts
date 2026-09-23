import { beforeAll, describe, expect, it } from 'bun:test';
import type { ContainerInfo, SwarmNodeInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { readRun, resumeMigration, runMeshMigration, startMigration, type MigrationSeams } from './mesh-migration.service';

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-mesh-migration';
});

const ORG = 'org_1';

/**
 * A simulated org: swarmy's DB rows + a fake hub whose swarm reacts to the
 * commands the runner dispatches (leave/rejoin mints a new id and a BLANK
 * spec, exactly like Docker).
 */
function harness(opts: { meshWorkerIp?: string; startOnMesh?: boolean; failRejoinOnce?: boolean; managerAddr?: string } = {}) {
  const meshIp = opts.meshWorkerIp ?? '100.92.0.11';
  const swarm: SwarmNodeInfo[] = [
    {
      swarmNodeId: 'sw-lon-a',
      hostname: 'lon-a',
      role: 'manager',
      availability: 'active',
      status: 'ready',
      leader: true,
      // Born on the mesh (installer node #1 with --mesh): the only shape in
      // which workers may move — see the manager-off-mesh blocker.
      addr: opts.managerAddr ?? '100.92.0.10',
      labels: { 'swarmy.region': 'lon' },
    },
    {
      swarmNodeId: 'sw-nyc-a',
      hostname: 'nyc-a',
      role: 'worker',
      availability: 'active',
      status: 'ready',
      leader: false,
      addr: opts.startOnMesh ? meshIp : '198.51.100.5',
      labels: { 'swarmy.region': 'nyc', 'swarmy.node.ingress': 'true', 'swarmy.node.outlet': '', 'swarmy.node.public-ip': '198.51.100.5' },
    },
  ];
  const services: { name: string; labels: Record<string, string>; constraints: string[] }[] = [
    { name: 'app_db', labels: { 'swarmy.db.node': 'sw-nyc-a' }, constraints: ['node.id==sw-nyc-a'] },
  ];
  const containers: Record<string, ContainerInfo[]> = {
    'lon-a': [],
    'nyc-a': [{ id: 'c1', state: 'running', serviceId: 'svc-db', labels: {} } as unknown as ContainerInfo],
  };
  const calls: { node: string; cmd: string; payload: Record<string, unknown> }[] = [];
  let rejoinFailures = opts.failRejoinOnce ? 1 : 0;
  let seq = 0;

  const db = {
    settings: {} as Record<string, unknown>,
    meshConfigRow: { orgId: ORG, driver: 'NETBIRD', enabled: true, settings: {} as unknown },
    peers: [
      { nodeId: 'lon-a', orgId: ORG, meshIp: '100.92.0.10', status: 'ONLINE' },
      { nodeId: 'nyc-a', orgId: ORG, meshIp: null as string | null, status: 'ENROLLING' },
    ],
    audits: [] as { action: string; metadata?: unknown }[],
  };
  const prisma = {
    meshConfig: {
      findUnique: async () => db.meshConfigRow,
      findMany: async () => [db.meshConfigRow],
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(db.meshConfigRow, data),
      upsert: async ({ update }: { update: Record<string, unknown> }) => Object.assign(db.meshConfigRow, update),
    },
    meshPeer: {
      findMany: async () => db.peers,
      findUnique: async ({ where }: { where: { nodeId: string } }) => db.peers.find((p) => p.nodeId === where.nodeId) ?? null,
    },
    node: {
      findMany: async () => [
        { id: 'lon-a', hostname: 'lon-a' },
        { id: 'nyc-a', hostname: 'nyc-a' },
      ],
    },
    swarmConfig: { upsert: async () => ({}) },
    auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => void db.audits.push(data) },
  };

  const byHost = (h: string) => swarm.filter((n) => n.hostname === h);
  const hub = {
    isOnline: () => true,
    managerNodes: () => ['lon-a'],
    nodeInventory: () => swarm,
    nodeInfoFor: (id: string) => byHost(id).find((n) => n.status !== 'down') ?? byHost(id)[0],
    latestContainers: (id: string) => containers[id] ?? [],
    liveInventory: () => ({
      services: services.map((s) => ({ id: s.name, name: s.name, image: 'postgres:16', labels: s.labels, networks: [] })),
      containers: [],
    }),
    async dispatch(node: string, cmd: string, payload: Record<string, unknown>) {
      calls.push({ node, cmd, payload });
      if (cmd === 'swarm.join' && payload.refreshOnly) {
        return { mode: 'init', swarmNodeId: 'sw-lon-a', managerAddr: '100.92.0.10:2377', joinTokens: { worker: 'W', manager: 'M' } };
      }
      if (cmd === 'swarm.join' && payload.rejoin) {
        if (rejoinFailures-- > 0) throw new Error('manager unreachable');
        const old = byHost(node).find((n) => n.status !== 'down')!;
        old.status = 'down';
        containers[node] = [];
        const fresh: SwarmNodeInfo = {
          swarmNodeId: `sw-${node}-${++seq}`,
          hostname: node,
          role: 'worker',
          availability: 'active',
          status: 'ready',
          leader: false,
          addr: (payload.advertiseAddr as string | undefined) ?? '198.51.100.5',
          labels: {},
        };
        swarm.push(fresh);
        return { mode: 'join', swarmNodeId: fresh.swarmNodeId };
      }
      if (cmd === 'node.update') {
        const target = swarm.find((n) => n.swarmNodeId === payload.swarmNodeId);
        if (!target) throw new Error('no such node');
        if (payload.remove) swarm.splice(swarm.indexOf(target), 1);
        if (payload.availability) target.availability = payload.availability as SwarmNodeInfo['availability'];
        if (payload.labels) target.labels = { ...target.labels, ...(payload.labels as Record<string, string>) };
        if (payload.availability === 'drain') containers[node === 'lon-a' ? target.hostname : node] = [];
        return {};
      }
      if (cmd === 'service.inspect') {
        const s = services.find((x) => x.name === payload.service)!;
        return {
          inspect: {
            Spec: {
              Name: s.name,
              Labels: s.labels,
              TaskTemplate: { ContainerSpec: { Image: 'postgres:16' }, Placement: { Constraints: s.constraints } },
            },
          },
        };
      }
      if (cmd === 'service.deploy') {
        const spec = payload.spec as { name: string; labels?: Record<string, string>; placement?: { constraints?: string[] } };
        const s = services.find((x) => x.name === spec.name)!;
        s.labels = spec.labels ?? {};
        s.constraints = spec.placement?.constraints ?? [];
        return {};
      }
      return {};
    },
  };

  const ctx = { db: prisma, hub, activeOrgId: ORG, user: { id: 'u1' } } as unknown as OrgContext;
  const seams: Partial<MigrationSeams> = {
    sleep: async () => undefined,
    pollMs: 0,
    meshTimeoutMs: 50,
    drainTimeoutMs: 50,
    readyTimeoutMs: 50,
    enroll: async (_c, nodeId) => {
      const p = db.peers.find((x) => x.nodeId === nodeId)!;
      p.meshIp = meshIp;
      p.status = 'ONLINE';
    },
  };
  return { ctx, seams, swarm, services, calls, db, meshIp };
}

async function settle(h: ReturnType<typeof harness>): Promise<void> {
  // startMigration kicks the runner in the background; run it to completion here.
  await runMeshMigration(h.ctx, h.seams);
  for (let i = 0; i < 20 && (await readRun(h.ctx))?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('mesh migration runner — onto the mesh', () => {
  it('moves the worker onto its mesh IP, restores labels, re-points the pin, removes the stale id; manager untouched', async () => {
    const h = harness();
    await startMigration(h.ctx, { direction: 'onto-mesh', acknowledgeWarnings: true }, h.seams);
    await settle(h);

    const run = (await readRun(h.ctx))!;
    expect(run.status).toBe('done');
    const nyc = h.swarm.filter((n) => n.hostname === 'nyc-a');
    expect(nyc).toHaveLength(1); // old entry `node rm`'d
    const moved = nyc[0]!;
    expect(moved.swarmNodeId).not.toBe('sw-nyc-a');
    expect(moved.addr).toBe(h.meshIp);
    expect(moved.availability).toBe('active');
    expect(moved.labels).toEqual({
      'swarmy.region': 'nyc',
      'swarmy.node.ingress': 'true',
      'swarmy.node.outlet': '',
      'swarmy.node.public-ip': '198.51.100.5',
    });
    // Pin followed the new id — label AND constraint.
    expect(h.services[0]!.labels['swarmy.db.node']).toBe(moved.swarmNodeId);
    expect(h.services[0]!.constraints).toEqual([`node.id==${moved.swarmNodeId}`]);

    // Rejoin carried advertise + data-path = mesh IP, via fresh tokens from the live manager.
    const rejoin = h.calls.find((c) => c.cmd === 'swarm.join' && c.payload.rejoin)!;
    expect(rejoin.node).toBe('nyc-a');
    expect(rejoin.payload).toMatchObject({ advertiseAddr: h.meshIp, dataPathAddr: h.meshIp, joinToken: 'W', managerAddr: '100.92.0.10:2377' });
    // The single manager is never drained / left.
    expect(h.calls.some((c) => c.cmd === 'swarm.join' && c.payload.rejoin && c.node === 'lon-a')).toBe(false);
    expect(h.swarm.find((n) => n.hostname === 'lon-a')!.swarmNodeId).toBe('sw-lon-a');

    const actions = h.db.audits.map((a) => a.action);
    expect(actions).toContain('mesh.migration.start');
    expect(actions).toContain('mesh.migration.nodeMoved');
    expect(actions).toContain('data.pinNode');
    expect(actions).toContain('mesh.migration.done');
  });

  it('refuses to start without acknowledging warnings (pinned data on a moving node)', async () => {
    const h = harness();
    await expect(startMigration(h.ctx, { direction: 'onto-mesh' }, h.seams)).rejects.toThrow('app_db is pinned to nyc-a');
  });

  it('refuses onto-mesh while the mesh is off', async () => {
    const h = harness();
    h.db.meshConfigRow.enabled = false;
    await expect(startMigration(h.ctx, { direction: 'onto-mesh', acknowledgeWarnings: true }, h.seams)).rejects.toThrow(
      'Turn the mesh on',
    );
  });

  it('stops on failure with a resumable state, undrains the node, and resumes to done', async () => {
    const h = harness({ failRejoinOnce: true });
    await startMigration(h.ctx, { direction: 'onto-mesh', acknowledgeWarnings: true }, h.seams);
    await settle(h);

    let run = (await readRun(h.ctx))!;
    expect(run.status).toBe('failed');
    const failed = run.nodes.find((n) => n.nodeId === 'nyc-a')!;
    expect(failed.step).toBe('rejoining');
    expect(failed.error).toContain('manager unreachable');
    expect(failed.snapshot?.labels['swarmy.region']).toBe('nyc'); // persisted before the leave
    expect(h.swarm.find((n) => n.swarmNodeId === 'sw-nyc-a')!.availability).toBe('active'); // put back in service
    expect(h.db.audits.map((a) => a.action)).toContain('mesh.migration.failed');

    await resumeMigration(h.ctx, h.seams);
    await settle(h);
    run = (await readRun(h.ctx))!;
    expect(run.status).toBe('done');
    expect(h.swarm.filter((n) => n.hostname === 'nyc-a')[0]!.addr).toBe(h.meshIp);
  });
});

describe('mesh migration runner — reverse (off the mesh)', () => {
  it('rejoins the mesh worker on its own address, restores labels + pin, and can turn the mesh off at the end', async () => {
    const h = harness({ startOnMesh: true, managerAddr: '203.0.113.10' });
    h.db.peers[1]!.meshIp = h.meshIp;
    h.db.peers[1]!.status = 'ONLINE';
    await startMigration(h.ctx, { direction: 'off-mesh', acknowledgeWarnings: true, disableWhenDone: true }, h.seams);
    await settle(h);

    const run = (await readRun(h.ctx))!;
    expect(run.status).toBe('done');
    const rejoin = h.calls.find((c) => c.cmd === 'swarm.join' && c.payload.rejoin)!;
    expect(rejoin.payload.advertiseAddr).toBeUndefined(); // agent derives its own non-mesh address
    expect(rejoin.payload.dataPathAddr).toBeUndefined();
    const back = h.swarm.filter((n) => n.hostname === 'nyc-a');
    expect(back).toHaveLength(1);
    expect(back[0]!.addr).toBe('198.51.100.5');
    expect(back[0]!.labels['swarmy.node.ingress']).toBe('true');
    expect(h.services[0]!.labels['swarmy.db.node']).toBe(back[0]!.swarmNodeId);
    // No enroll off-mesh; the mesh is switched off once done.
    expect(h.db.meshConfigRow.enabled).toBe(false);
    expect(h.db.audits.map((a) => a.action)).toContain('mesh.migration.nodeRestored');
  });
});
