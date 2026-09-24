import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import { decommissionStatus, garageResynced, loop, startDecommission, type DecomRun, type RunnerDeps } from './decommission.service';

const deps: RunnerDeps = {
  now: (() => {
    let t = 1_800_000_000_000;
    return () => (t += 1000);
  })(),
  sleep: async () => {},
  secret: () => 'x',
  dnsSettleMs: 0,
};

/** Two servers; `b` runs one stateless app. node.update/runOnce behave like swarm. */
function cluster() {
  const calls: { node: string; cmd: string; payload: any }[] = [];
  const swarm: Record<string, SwarmNodeInfo | undefined> = {
    a: { swarmNodeId: 'swa', hostname: 'a', role: 'manager', availability: 'active', status: 'ready', leader: true, labels: {} },
    b: { swarmNodeId: 'swb', hostname: 'b', role: 'worker', availability: 'active', status: 'ready', leader: false, labels: {} },
  };
  let bContainers = [{ id: 'c1', name: 'web_api.1', image: 'api', state: 'running', labels: { 'com.docker.swarm.service.name': 'web_api' } }];
  const online = new Set(['a', 'b']);
  let nodeRows = [
    { id: 'a', name: 'a', hostname: 'a' },
    { id: 'b', name: 'b', hostname: 'b' },
  ];
  let opRun: unknown = null;
  const hub: any = {
    isOnline: (n: string) => online.has(n),
    onlineNodeIds: () => [...online],
    nodeInfoFor: (n: string) => swarm[n],
    swarmNodeIdFor: (n: string) => swarm[n]?.swarmNodeId,
    nodeInventory: () => Object.values(swarm).filter(Boolean),
    latestNodeStats: () => ({ fsUsedBytes: 1, fsTotalBytes: 100 }),
    latestContainers: (n: string) => (n === 'b' ? bContainers : []),
    liveInventory: () => ({
      services: [{ name: 'web_api', mode: 'replicated', desiredReplicas: 2, labels: {}, image: 'api', env: [], networks: [] }],
      containers: [],
    }),
    managerNode: () => 'a',
    dispatch: async (node: string, cmd: string, payload: any) => {
      calls.push({ node, cmd, payload });
      if (cmd === 'node.update' && payload.swarmNodeId === 'swb') {
        if (payload.remove) swarm.b = undefined;
        else if (payload.availability) {
          swarm.b = { ...swarm.b!, availability: payload.availability };
          if (payload.availability === 'drain') bContainers = [];
        }
      }
      if (cmd === 'container.runOnce' && node === 'b' && payload.cmd?.[0] === 'docker swarm leave') online.delete('b');
      return {};
    },
  };
  const db: any = {
    node: {
      findMany: async () => nodeRows,
      findFirst: async ({ where }: any) => nodeRows.find((r) => r.id === where.id) ?? null,
      delete: async ({ where }: any) => {
        nodeRows = nodeRows.filter((r) => r.id !== where.id);
      },
    },
    snapshot: { findMany: async () => [] },
    backupTarget: { count: async () => 1, findFirst: async () => null },
    operationRun: {
      findUnique: async () => (opRun ? { run: opRun } : null),
      upsert: async ({ create }: any) => {
        opRun = JSON.parse(JSON.stringify(create.run));
      },
    },
    auditLog: { create: async () => ({}) },
  };
  const ctx: any = { hub, db, activeOrgId: 'org', user: { id: 'u' } };
  return { ctx, calls, swarm, nodeRows: () => nodeRows };
}

function freshRun(): DecomRun {
  return {
    runId: 'r1',
    nodeId: 'b',
    hostname: 'b',
    status: 'running',
    done: [],
    current: null,
    log: [],
    error: null,
    startedAt: '',
    finishedAt: null,
    startedBy: null,
  };
}

describe('decommission runner', () => {
  it('runs a stateless worker end to end: pause → drain → leave → forget, re-planning each step', async () => {
    const c = cluster();
    const run = await loop(c.ctx, freshRun(), { stop: false }, deps);
    expect(run.status).toBe('done');
    expect(run.done.map((d) => d.split(':')[0])).toEqual(['cordon', 'drain', 'swarm-leave', 'forget']);
    const updates = c.calls.filter((x) => x.cmd === 'node.update').map((x) => x.payload.availability ?? (x.payload.remove ? 'remove' : '?'));
    expect(updates).toEqual(['pause', 'drain', 'remove']);
    expect(c.calls.find((x) => x.cmd === 'container.runOnce')!.payload.cmd).toEqual(['docker swarm leave']);
    expect(c.nodeRows().map((r) => r.id)).toEqual(['a']);
    expect(run.log.at(-1)!.message).toContain('destroy the server at your provider');
  });

  it('stop is honoured between steps and the run resumes where it left off', async () => {
    const c = cluster();
    const handle = { stop: false };
    const run = freshRun();
    const first = loop(c.ctx, run, handle, {
      ...deps,
      sleep: async () => {
        handle.stop = true;
      },
    });
    handle.stop = true;
    const stopped = await first;
    expect(stopped.status).toBe('stopped');
    const resumed = await loop(c.ctx, { ...stopped, status: 'running' }, { stop: false }, deps);
    expect(resumed.status).toBe('done');
    expect(new Set(resumed.done).size).toBe(resumed.done.length);
  });

  it('start refuses the wrong hostname and unaccepted warnings; status reads interrupted runs', async () => {
    const c = cluster();
    await expect(startDecommission(c.ctx, { id: 'b', confirmHostname: 'nope', acceptWarnings: true }, deps)).rejects.toThrow("type the server's name");
    await c.ctx.db.operationRun.upsert({ create: { run: { ...freshRun(), status: 'running', runId: 'dead' } } });
    expect((await decommissionStatus(c.ctx, 'b'))!.status).toBe('interrupted');
  });

  it('a blocker that appears mid-run stops it', async () => {
    const c = cluster();
    // The only other server goes away: nowhere left to move to.
    c.swarm.a = { ...c.swarm.a!, status: 'down' };
    const run = await loop(c.ctx, freshRun(), { stop: false }, deps);
    expect(run.status).toBe('failed');
    expect(run.error).toContain("can't be retired yet");
    expect(c.calls.some((x) => x.cmd === 'node.update')).toBe(false);
  });
});

describe('garageResynced', () => {
  const healthy = { status: 'healthy', partitions: 256, partitionsAllOk: 256 };
  it('needs a newer layout, all partitions ok, and the server no longer draining', () => {
    expect(garageResynced({ layoutVersion: 4, health: healthy, nodes: [] }, 'b', 4)).toBe(false);
    expect(garageResynced({ layoutVersion: 5, health: healthy, nodes: [{ nodeId: 'b', draining: true }] }, 'b', 4)).toBe(false);
    expect(garageResynced({ layoutVersion: 5, health: { ...healthy, partitionsAllOk: 200 }, nodes: [] }, 'b', 4)).toBe(false);
    expect(garageResynced({ layoutVersion: 5, health: healthy, nodes: [{ nodeId: 'b', draining: false }] }, 'b', 4)).toBe(true);
    expect(garageResynced(null, 'b', 4)).toBe(false);
  });
});
