import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { moveServiceData, serveSpec, switchoverDb, type MoverDeps, type SwitchoverDeps } from './volumeMove.service';

/**
 * A tiny fake swarm: two servers, one service with a volume. Dispatches are
 * recorded; scale/deploy move the service's container like swarm would, and
 * runOnce answers like the mover scripts do.
 */
function fakeSwarm(opts: { destNotEmpty?: boolean; manifestMismatch?: boolean; startFails?: boolean } = {}) {
  const calls: { node: string; cmd: string; payload: any }[] = [];
  const svc: SwarmServiceInfo = {
    id: 'svc1',
    name: 'blog_ghost',
    image: 'ghost:5',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'blog' },
    networks: [{ name: 'blog_default', aliases: [] }],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    mounts: [{ type: 'volume', source: 'blog_content', target: '/var/lib/ghost/content' }],
  };
  let runningOn: string | null = 'n1';
  const container = (): ContainerInfo => ({
    id: 'c1',
    name: 'blog_ghost.1',
    image: 'ghost:5',
    state: 'running',
    status: 'Up',
    createdAt: 0,
    ports: [],
    labels: { 'com.docker.swarm.service.name': 'blog_ghost' },
  });
  const swarmIds: Record<string, string> = { n1: 'sw1', n2: 'sw2' };
  const hub: any = {
    onlineNodeIds: () => ['n1', 'n2'],
    isOnline: () => true,
    latestContainers: (n: string) => (runningOn === n ? [container()] : []),
    liveInventory: () => ({ services: [svc], containers: [] }),
    nodeInfoFor: (n: string) => ({ swarmNodeId: swarmIds[n], hostname: n === 'n1' ? 'fra-1' : 'hel-1', availability: 'active', status: 'ready' }),
    swarmNodeIdFor: (n: string) => swarmIds[n],
    managerNode: () => 'n1',
    dispatch: async (node: string, cmd: string, payload: any) => {
      calls.push({ node, cmd, payload });
      if (cmd === 'service.inspect') {
        return {
          inspect: {
            Spec: {
              Name: 'blog_ghost',
              Labels: svc.labels,
              Mode: { Replicated: { Replicas: 1 } },
              TaskTemplate: {
                ContainerSpec: { Image: 'ghost:5', Mounts: [{ Type: 'volume', Source: 'blog_content', Target: '/var/lib/ghost/content' }] },
                Placement: { Constraints: ['node.id==sw1'] },
              },
            },
          },
        };
      }
      if (cmd === 'service.scale' && payload.service === 'blog_ghost') runningOn = payload.replicas > 0 ? 'n1' : null;
      if (cmd === 'service.deploy' && payload.spec.name === 'blog_ghost') {
        const pin = (payload.spec.placement?.constraints ?? []).find((c: string) => c.startsWith('node.id=='));
        const target = pin === 'node.id==sw2' ? 'n2' : 'n1';
        runningOn = target === 'n2' && opts.startFails ? null : target;
      }
      if (cmd === 'container.runOnce') {
        const script: string = payload.cmd[0];
        if (script.includes('rsync://')) {
          if (opts.destNotEmpty && script.includes('SWARMY_DEST_NOT_EMPTY')) return { exitCode: 42, output: 'SWARMY_DEST_NOT_EMPTY' };
          return { exitCode: 0, output: 'Total transferred file size: 1,024 bytes\nSWARMY_RSYNC_EXIT=0' };
        }
        if (script.includes('DIGEST=')) {
          const digest = opts.manifestMismatch && node === 'n2' ? 'bbb' : 'aaa';
          return { exitCode: 0, output: `FILES=3\nLINKS=0\nDIRS=2\nBYTES=1024\nDIGEST=${digest}\n` };
        }
      }
      return {};
    },
  };
  const ctx: any = { hub, activeOrgId: 'org', db: { auditLog: { create: async () => ({}) } }, user: { id: 'u' } };
  return { ctx, calls, svc, running: () => runningOn };
}

const deps: MoverDeps = { now: (() => { let t = 1_800_000_000_000; return () => (t += 1000); })(), sleep: async () => {}, secret: () => 'pw' };

describe('moveServiceData', () => {
  it('serve → live pass → stop → final pass → verify both sides → re-pin → start → cleanup', async () => {
    const { ctx, calls, running } = fakeSwarm();
    const steps: string[] = [];
    const res = await moveServiceData(ctx, { service: 'blog_ghost', toNodeId: 'n2' }, (p) => steps.push(p.step), deps);
    expect(running()).toBe('n2');
    expect(res.from.hostname).toBe('fra-1');
    expect(res.to.hostname).toBe('hel-1');
    expect(res.volumes.map((v) => v.name)).toEqual(['blog_content']);

    const seq = calls.map((c) => c.cmd).filter((c) => c !== 'service.updateLabels' && c !== 'service.inspect');
    expect(seq).toEqual([
      'secret.create',
      'service.deploy', // serve
      'container.runOnce', // live pass (dest)
      'service.scale', // stop
      'container.runOnce', // final pass
      'container.runOnce', // manifest source
      'container.runOnce', // manifest dest
      'service.deploy', // re-pinned app
      'service.remove', // serve
      'secret.remove',
    ]);
    const passes = calls.filter((c) => c.cmd === 'container.runOnce' && c.payload.cmd[0].includes('rsync://'));
    expect(passes.every((p) => p.node === 'n2')).toBe(true);
    expect(passes[0]!.payload.env).toEqual({ RSYNC_PASSWORD: 'pw' });
    expect(passes[0]!.payload.cmd[0]).toContain('SWARMY_DEST_NOT_EMPTY'); // first pass refuses a non-empty destination
    expect(passes[1]!.payload.cmd[0]).not.toContain('SWARMY_DEST_NOT_EMPTY');
    const manifests = calls.filter((c) => c.cmd === 'container.runOnce' && c.payload.cmd[0].includes('DIGEST='));
    expect(manifests.map((m) => m.node)).toEqual(['n1', 'n2']);
    expect(manifests[0]!.payload.binds).toEqual(['blog_content:/dst:ro']);
    // The secret never appears in a service spec or argv.
    const serve = calls.find((c) => c.cmd === 'service.deploy')!.payload.spec;
    expect(JSON.stringify(serve)).not.toContain('"pw"');
    const repinned = calls.filter((c) => c.cmd === 'service.deploy')[1]!.payload.spec;
    expect(repinned.placement.constraints).toEqual(['node.id==sw2']);
    expect(repinned.mode).toEqual({ replicated: { replicas: 1 } });
    expect(JSON.parse(repinned.labels['swarmy.move.oldCopies'])[0]).toMatchObject({ nodeId: 'n1', volume: 'blog_content' });
    expect(steps).toContain('done');
  });

  it('refuses a destination that already holds data, touches nothing there, and restarts nothing', async () => {
    const { ctx, calls, running } = fakeSwarm({ destNotEmpty: true });
    await expect(moveServiceData(ctx, { service: 'blog_ghost', toNodeId: 'n2' }, () => {}, deps)).rejects.toThrow('will not overwrite');
    expect(running()).toBe('n1');
    expect(calls.some((c) => c.cmd === 'service.scale')).toBe(false);
    expect(calls.some((c) => c.cmd === 'volume.remove')).toBe(false);
    expect(calls.some((c) => c.cmd === 'service.remove')).toBe(true);
  });

  it('a checksum mismatch rolls back to the source and removes only the copy it made', async () => {
    const { ctx, calls, running } = fakeSwarm({ manifestMismatch: true });
    await expect(moveServiceData(ctx, { service: 'blog_ghost', toNodeId: 'n2' }, () => {}, deps)).rejects.toThrow('does not match');
    expect(running()).toBe('n1');
    const rm = calls.filter((c) => c.cmd === 'volume.remove');
    expect(rm.map((c) => [c.node, c.payload.name])).toEqual([['n2', 'blog_content']]);
    expect(calls.filter((c) => c.cmd === 'service.scale').map((c) => c.payload.replicas)).toEqual([0, 1]);
  });

  it('failing to start on the destination re-deploys the original spec on the source', async () => {
    const { ctx, calls, running } = fakeSwarm({ startFails: true });
    await expect(moveServiceData(ctx, { service: 'blog_ghost', toNodeId: 'n2' }, () => {}, deps)).rejects.toThrow('timed out');
    expect(running()).toBe('n1');
    const deploys = calls.filter((c) => c.cmd === 'service.deploy' && c.payload.spec.name === 'blog_ghost');
    expect(deploys.at(-1)!.payload.spec.placement.constraints).toEqual(['node.id==sw1']);
  });

  it('refuses the same server, managed primaries and multi-copy services', async () => {
    const a = fakeSwarm();
    await expect(moveServiceData(a.ctx, { service: 'blog_ghost', toNodeId: 'n1' }, () => {}, deps)).rejects.toThrow('already on');
    const b = fakeSwarm();
    b.svc.labels['swarmy.db.role'] = 'primary';
    await expect(moveServiceData(b.ctx, { service: 'blog_ghost', toNodeId: 'n2' }, () => {}, deps)).rejects.toThrow('switchover');
    const c = fakeSwarm();
    c.svc.desiredReplicas = 3;
    await expect(moveServiceData(c.ctx, { service: 'blog_ghost', toNodeId: 'n2' }, () => {}, deps)).rejects.toThrow('3 copies');
  });
});

describe('serveSpec', () => {
  it('read-only mounts, pinned to the source, secret file, no published ports', () => {
    const s = serveSpec('abc', ['v1'], 'sw1');
    expect(s.mounts).toEqual([{ type: 'volume', source: 'v1', target: '/src/v1', readOnly: true }]);
    expect(s.placement?.constraints).toEqual(['node.id==sw1']);
    expect(s.secrets).toEqual([{ source: 'swarmy-move-abc-secret', target: 'swarmy-move-secret' }]);
    expect(s.ports).toBeUndefined();
    expect(s.networks).toEqual(['swarmy']);
  });
});

describe('switchoverDb', () => {
  function pgSwarm(opts: { lagStuck?: boolean } = {}) {
    const calls: { cmd: string; payload: any }[] = [];
    const base = { mode: 'replicated' as const, createdAt: 0, updatedAt: 0, networks: [], env: [], ports: [], secrets: [], configs: [], image: 'pgvector/pgvector:pg17' };
    const primary: SwarmServiceInfo = {
      ...base, id: 'p', name: 'shop_db-primary', desiredReplicas: 1, runningReplicas: 1,
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'primary', 'swarmy.db.replicas': '1', 'swarmy.db.node': 'sw1', 'swarmy.db.dataVolume': 'shop_db-primary-data' },
    };
    const replica: SwarmServiceInfo = {
      ...base, id: 'r', name: 'shop_db-replica', desiredReplicas: 1, runningReplicas: 1,
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'replica', 'swarmy.db.replicas': '1' },
    };
    const on: Record<string, string> = { 'shop_db-primary': 'n1', 'shop_db-replica': 'n2' };
    const hub: any = {
      onlineNodeIds: () => ['n1', 'n2', 'n3'],
      isOnline: () => true,
      latestContainers: (n: string) =>
        Object.entries(on).filter(([, node]) => node === n).map(([name]) => ({ id: name, name, state: 'running', labels: { 'com.docker.swarm.service.name': name } })),
      liveInventory: () => ({ services: [primary, replica], containers: [] }),
      nodeInfoFor: (n: string) => ({ hostname: n }),
      swarmNodeIdFor: (n: string) => `sw${n.slice(1)}`,
      managerNode: () => 'n1',
      dispatch: async (_n: string, cmd: string, payload: any) => {
        calls.push({ cmd, payload });
        if (cmd === 'service.scale' && payload.service === primary.name && payload.replicas === 0) {
          delete on[primary.name];
          // manageddb-reconcile promotes (decideFailover) on its next tick:
          replica.labels['swarmy.db.role'] = 'primary';
          primary.labels['swarmy.db.role'] = 'replica';
        }
        return {};
      },
    };
    const sql: string[] = [];
    let frozen = false;
    const deps: SwitchoverDeps = {
      ...{ now: (() => { let t = 0; return () => (t += 1000); })(), sleep: async () => {}, secret: () => 'x' },
      psql: async (service, q) => {
        sql.push(`${service}: ${q}`);
        if (q.includes('SET default_transaction_read_only = on')) frozen = true;
        if (q.includes('RESET')) frozen = false;
        if (q.includes('pg_current_wal_flush_lsn')) return '0/3000000';
        if (q.includes('pg_last_wal_replay_lsn')) return opts.lagStuck || !frozen ? '0/2FFFF00' : '0/3000000';
        return 't';
      },
      setReplicas: async () => {},
      setTopology: async () => {},
    };
    const ctx: any = { hub, activeOrgId: 'org', db: { auditLog: { create: async () => ({}) } } };
    return { ctx, calls, sql, deps, primary, replica, frozen: () => frozen };
  }

  it('freezes writes, waits for 0 bytes behind, stops the primary with the switchover label, un-pins the demoted member', async () => {
    const t = pgSwarm();
    const res = await switchoverDb(t.ctx, { stack: 'shop', cluster: 'db', avoidNodeId: 'n1' }, t.deps);
    expect(res).toEqual({ promoted: 'shop_db-replica', demoted: 'shop_db-primary', addedReplica: false });
    const label = t.calls.find((c) => c.cmd === 'service.updateLabels' && c.payload.add['swarmy.db.switchover']);
    expect(label).toBeDefined();
    const iFreeze = t.sql.findIndex((q) => q.includes('read_only = on'));
    expect(iFreeze).toBeGreaterThan(-1);
    // Still frozen when the primary stops (no write window before the stop).
    expect(t.frozen()).toBe(true);
    const redeploy = t.calls.find((c) => c.cmd === 'service.deploy')!.payload.spec;
    expect(redeploy.name).toBe('shop_db-primary');
    expect(redeploy.labels['swarmy.db.node']).toBeUndefined();
    expect(redeploy.labels['swarmy.db.avoidNode']).toBe('sw2');
    expect(redeploy.placement.constraints).toContain('node.id!=sw1');
  });

  it('a replica that never catches up cancels before anything stops, and writes resume', async () => {
    const t = pgSwarm({ lagStuck: true });
    await expect(switchoverDb(t.ctx, { stack: 'shop', cluster: 'db', avoidNodeId: 'n1' }, t.deps)).rejects.toThrow('bytes behind');
    expect(t.calls.some((c) => c.cmd === 'service.scale')).toBe(false);
    expect(t.frozen()).toBe(false);
  });
});
