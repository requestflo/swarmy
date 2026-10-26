import { describe, expect, it } from 'bun:test';
import { oldCopy } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { MoverDeps } from './volumeMove.service';
import { checkUndoMove, runUndoMove } from './volumeMove.undo';

const T0 = 1_800_000_000_000;
const SNAP = { files: 3, links: 0, dirs: 2, bytes: 1024, digest: 'aaa' };

/** ghost moved fra-1 (n1) → hel-1 (n2) a minute ago; the old copy kept on n1 with its snapshot point. */
function fakeSwarm() {
  const calls: { node: string; cmd: string; payload: any }[] = [];
  const digest: Record<string, string> = { n1: 'aaa', n2: 'aaa' };
  const svc: SwarmServiceInfo = {
    id: 'svc1', name: 'blog_ghost', image: 'ghost:5', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
    labels: {
      'com.docker.stack.namespace': 'blog',
      'swarmy.move.oldCopies': JSON.stringify([oldCopy('n1', 'blog_content', T0, { moveId: 'm1', to: 'n2', manifest: SNAP })]),
    },
    networks: [], env: [], ports: [], secrets: [], configs: [],
    mounts: [{ type: 'volume', source: 'blog_content', target: '/var/lib/ghost/content' }],
  };
  let runningOn: string | null = 'n2';
  const swarmIds: Record<string, string> = { n1: 'sw1', n2: 'sw2' };
  const hub: any = {
    onlineNodeIds: () => ['n1', 'n2'],
    isOnline: () => true,
    latestContainers: (n: string) =>
      runningOn === n ? [{ id: 'c1', name: 'g.1', image: 'ghost:5', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: { 'com.docker.swarm.service.name': 'blog_ghost' } }] : [],
    liveInventory: () => ({ services: [svc], containers: [] }),
    nodeInfoFor: (n: string) => ({ swarmNodeId: swarmIds[n], hostname: n === 'n1' ? 'fra-1' : 'hel-1', availability: 'active', status: 'ready' }),
    swarmNodeIdFor: (n: string) => swarmIds[n],
    managerNode: () => 'n1',
    dispatch: async (node: string, cmd: string, payload: any) => {
      calls.push({ node, cmd, payload });
      if (cmd === 'service.inspect') {
        const Mounts = [{ Type: 'volume', Source: 'blog_content', Target: '/var/lib/ghost/content' }];
        return { inspect: { Spec: { Name: 'blog_ghost', Labels: svc.labels, Mode: { Replicated: { Replicas: 1 } }, TaskTemplate: { ContainerSpec: { Image: 'ghost:5', Mounts }, Placement: { Constraints: ['node.id==sw2'] } } } } };
      }
      if (cmd === 'service.scale') runningOn = payload.replicas > 0 ? 'n2' : null;
      if (cmd === 'service.deploy') runningOn = payload.spec.placement.constraints.includes('node.id==sw1') ? 'n1' : 'n2';
      if (cmd === 'container.runOnce') return { exitCode: 0, output: `FILES=3\nLINKS=0\nDIRS=2\nBYTES=1024\nDIGEST=${digest[node]}\n` };
      return {};
    },
  };
  const audits: string[] = [];
  const ctx: any = { hub, activeOrgId: 'org', db: { auditLog: { create: async (a: any) => audits.push(a.data.action) } }, user: { id: 'u' } };
  return { ctx, calls, digest, audits, running: () => runningOn };
}

const deps = (): MoverDeps => {
  let t = T0 + 60_000;
  return { now: () => (t += 1000), sleep: async () => {}, secret: () => 'pw' };
};

describe('undo a move', () => {
  it('checks both copies, stops, re-checks the moved copy, re-pins to the old copy and keeps the moved one', async () => {
    const { ctx, calls, running } = fakeSwarm();
    const plan = await checkUndoMove(ctx, { service: 'blog_ghost' }, deps());
    expect(plan.source.hostname).toBe('fra-1');
    await runUndoMove(ctx, plan, deps());
    expect(running()).toBe('n1');
    const seq = calls.map((c) => (c.cmd === 'container.runOnce' ? `manifest@${c.node}` : c.cmd)).filter((c) => c !== 'service.updateLabels' && c !== 'service.inspect');
    expect(seq).toEqual(['manifest@n1', 'manifest@n2', 'service.scale', 'manifest@n2', 'service.deploy']);
    expect(calls.some((c) => c.cmd === 'container.runOnce' && c.payload.cmd[0].includes('rsync'))).toBe(false); // nothing copied
    const spec = calls.find((c) => c.cmd === 'service.deploy')!.payload.spec;
    expect(spec.placement.constraints).toEqual(['node.id==sw1']);
    const kept = JSON.parse(spec.labels['swarmy.move.oldCopies']);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ nodeId: 'n2', volume: 'blog_content', to: 'n1', manifest: SNAP });
    expect(JSON.parse(spec.labels['swarmy.move.state'])).toMatchObject({ undo: true, step: 'start', from: 'n2', to: 'n1' });
  });

  it('refuses up front, touching nothing, when the app wrote on the new server', async () => {
    const { ctx, calls, digest, running } = fakeSwarm();
    digest.n2 = 'bbb';
    await expect(checkUndoMove(ctx, { service: 'blog_ghost' }, deps())).rejects.toThrow('Writes happened on hel-1 since the move; undoing would lose them.');
    expect(calls.some((c) => ['service.scale', 'service.deploy', 'service.updateLabels'].includes(c.cmd))).toBe(false);
    expect(running()).toBe('n2');
  });

  it('refuses when the old copy changed on the old server', async () => {
    const { ctx, digest } = fakeSwarm();
    digest.n1 = 'ccc';
    await expect(checkUndoMove(ctx, { service: 'blog_ghost' }, deps())).rejects.toThrow("The old copy on fra-1 changed after the move");
  });

  it('a write between the check and the stop starts it again where it was, and audits why', async () => {
    const { ctx, calls, digest, audits, running } = fakeSwarm();
    const plan = await checkUndoMove(ctx, { service: 'blog_ghost' }, deps());
    digest.n2 = 'bbb';
    await expect(runUndoMove(ctx, plan, deps())).rejects.toThrow('Writes happened on hel-1 since the move');
    expect(running()).toBe('n2');
    expect(calls.some((c) => c.cmd === 'service.deploy')).toBe(false);
    expect(calls.at(-1)).toMatchObject({ cmd: 'service.updateLabels', payload: { removeKeys: ['swarmy.move.state'] } });
    expect(audits).toContain('volume.move.undo.rolledBack');
  });
});
