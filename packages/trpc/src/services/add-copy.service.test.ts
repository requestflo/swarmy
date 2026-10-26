import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { addCopy, copyPlan } from './add-copy.service';

/** Three workers; shop_web runs one copy on n1 and one on n2; n3 holds one other task. */
function fakeSwarm(opts: { volume?: boolean; constraints?: string[]; sleeps?: boolean } = {}) {
  const calls: { cmd: string; payload: any }[] = [];
  const svc: SwarmServiceInfo = {
    id: 'svc1', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 2, runningReplicas: 2, createdAt: 0, updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', ...(opts.sleeps ? { 'swarmy.scaleToZero.enabled': 'true', 'swarmy.scaleToZero.targetReplicas': '2' } : {}) },
    networks: [], env: [], ports: [], secrets: [], configs: [],
    mounts: opts.volume ? [{ type: 'volume', source: 'shop_uploads', target: '/uploads' }] : [],
  };
  const task = (service: string): ContainerInfo => ({ id: service, name: service, image: 'x', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: { 'com.docker.swarm.service.name': service } });
  const tasks: Record<string, ContainerInfo[]> = { n1: [task('shop_web'), task('shop_api')], n2: [task('shop_web'), task('shop_api')], n3: [task('shop_worker')] };
  const host = (n: string) => ({ swarmNodeId: `sw-${n}`, hostname: `wkr-${n.slice(1)}`, role: 'worker', availability: 'active', status: 'ready', labels: {} });
  const hub: any = {
    onlineNodeIds: () => ['n1', 'n2', 'n3'],
    isOnline: () => true,
    latestContainers: (n: string) => tasks[n] ?? [],
    liveInventory: () => ({ services: [svc], containers: [] }),
    nodeInventory: () => ['n1', 'n2', 'n3'].map(host),
    nodeInfoFor: (n: string) => host(n),
    swarmNodeIdFor: (n: string) => `sw-${n}`,
    managerNode: () => 'n1',
    dispatch: async (_node: string, cmd: string, payload: any) => {
      calls.push({ cmd, payload });
      if (cmd === 'service.inspect') {
        return { inspect: { Spec: { Name: 'shop_web', Labels: svc.labels, Mode: { Replicated: { Replicas: 2 } }, TaskTemplate: { ContainerSpec: { Image: 'web:1' }, Placement: { Constraints: opts.constraints ?? [] } } } } };
      }
      return {};
    },
  };
  const audits: any[] = [];
  const ctx: any = { hub, activeOrgId: 'org', db: { auditLog: { create: async (a: any) => audits.push(a.data) } }, user: { id: 'u' } };
  return { ctx, calls, audits };
}

describe('add a copy on a server', () => {
  it('scales by one when Swarm would start the new copy on the server it was dropped on', async () => {
    const { ctx, calls, audits } = fakeSwarm();
    expect(await copyPlan(ctx, { id: 'svc1', toNodeId: 'n3' })).toMatchObject({ ok: true, replicas: 3, note: null });
    expect(await addCopy(ctx, { id: 'svc1', toNodeId: 'n3' })).toEqual({ service: 'shop_web', replicas: 3, to: 'wkr-3' });
    expect(calls.filter((c) => c.cmd !== 'service.inspect')).toEqual([{ cmd: 'service.scale', payload: { service: 'shop_web', replicas: 3 } }]);
    expect(audits[0]).toMatchObject({ action: 'service.copy.add', metadata: { name: 'shop_web', from: 2, to: 3, server: 'wkr-3' } });
  });

  it('keeps a sleeping service waking to the new count', async () => {
    const { ctx, calls } = fakeSwarm({ sleeps: true });
    await addCopy(ctx, { id: 'svc1', toNodeId: 'n3' });
    expect(calls.at(-1)).toEqual({ cmd: 'service.updateLabels', payload: { service: 'shop_web', add: { 'swarmy.scaleToZero.targetReplicas': '3' }, removeKeys: [] } });
  });

  it('refuses, scaling nothing, where Swarm would put it elsewhere, for a stateful service, or against its rules', async () => {
    const cases: [ReturnType<typeof fakeSwarm>, string, string][] = [
      [fakeSwarm(), 'n1', 'it would start on wkr-3, not on wkr-1'],
      [fakeSwarm({ volume: true }), 'n3', 'keeps its data on its server (shop_uploads)'],
      [fakeSwarm({ constraints: ['node.hostname!=wkr-3'] }), 'n3', "web's placement rules keep it off wkr-3"],
    ];
    for (const [{ ctx, calls }, to, words] of cases) {
      await expect(addCopy(ctx, { id: 'svc1', toNodeId: to })).rejects.toThrow(words);
      expect(calls.some((c) => c.cmd === 'service.scale')).toBe(false);
    }
  });
});
