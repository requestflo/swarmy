/**
 * Controller-store helpers for the P3 steps: controller-move
 * (steps/platform.ts) and the drain / partition drills
 * (steps/controller-drills.ts).
 */
import type { Ctx } from '../context';
import type { ClusterNode } from './cluster';
import { assert, log, poll } from './util';

export const CONTROLLER_SERVICE = 'swarmy_controller';

/** What the drills read off `controllerStore.status` (ControllerStoreView). */
export interface StoreStatus {
  hostname: string;
  epoch: number | null;
  mode: 'replicated' | 'local-only';
  replicating: boolean;
  lagSeconds: number | null;
  summary?: string;
  target: unknown;
  boot: { kind: string; outcome: string } | null;
  managers: Array<{ swarmNodeId: string; hostname: string; blocked: string | null }>;
}

/** docker CLI on a chosen node: a drill can't use node 1 while node 1 is the one cut off. */
export function dockerOn(ctx: Ctx, node: ClusterNode, args: string, timeoutMs = 60_000): Promise<string> {
  return ctx.cluster.mustSh(node, `docker ${args}`, { timeoutMs }, `${node.name}: docker ${args.slice(0, 50)}`);
}

/** Every node a swarm manager: with 3, one side of a partition keeps raft quorum. */
export async function promoteAll(ctx: Ctx): Promise<void> {
  const rows = (await ctx.sdk.nodes.list({ limit: 100 })).data;
  for (const n of ctx.cluster.workers) {
    const host = await ctx.hostnameOf(n);
    const row = rows.find((r) => r.hostname === host);
    assert(row, `no REST node for ${host}`);
    if (row.role !== 'manager') await ctx.m('swarm.promote', { id: row.id });
  }
  const want = ctx.cluster.nodes.length;
  await poll(`${want} swarm managers`, async () => {
    const out = await ctx.docker(`node ls --format '{{.ManagerStatus}}'`);
    return out.split('\n').filter((l) => /Reachable|Leader/.test(l)).length >= want;
  }, { timeoutMs: 4 * 60_000, intervalMs: 5000 });
}

/** Poll the store until it is replicated, shipping and caught up (re-signing in across a controller restart). */
export async function waitCaughtUp(ctx: Ctx, timeoutMs = 10 * 60_000): Promise<StoreStatus> {
  return poll('controller store replicated and caught up (lag 0)', async () => {
    let st: StoreStatus;
    try {
      st = await ctx.q<StoreStatus>('controllerStore.status');
    } catch {
      await ctx.connect(ctx.password || undefined).catch(() => {});
      return null;
    }
    return st.mode === 'replicated' && st.replicating && st.lagSeconds === 0 ? st : null;
  }, { timeoutMs, intervalMs: 5000 });
}

/** Turn on Garage and replicate control.db into it (once), then wait until caught up. */
export async function ensureReplicated(ctx: Ctx): Promise<StoreStatus> {
  await ctx.m('storage.enable', undefined, 5 * 60_000).catch((e) => {
    if (!/already/i.test((e as Error).message)) throw e;
  });
  await poll('object store up', async () => (await ctx.q<{ enabled: boolean }>('storage.status'))?.enabled, {
    timeoutMs: 8 * 60_000,
    intervalMs: 10_000,
  });
  const now = await ctx.q<StoreStatus>('controllerStore.status').catch(() => null);
  if (now?.mode !== 'replicated') {
    // enableReplication restarts the controller with Litestream on.
    await poll('controllerStore.enableReplication accepted', async () => (await ctx.m('controllerStore.enableReplication', { target: { kind: 'garage' } }), true), {
      timeoutMs: 8 * 60_000,
      intervalMs: 10_000,
    });
  }
  const st = await waitCaughtUp(ctx);
  log(`${st.summary ?? 'replicating'}; epoch ${st.epoch}; on ${st.hostname}`);
  return st;
}

/** Wait until the controller task runs on a node other than `notOn`; `via` must be a manager with quorum. */
export async function controllerMovedOff(ctx: Ctx, via: ClusterNode, notOn: string, timeoutMs = 10 * 60_000): Promise<ClusterNode> {
  const line = await poll(`controller task running off ${notOn}`, async () => {
    const out = await dockerOn(ctx, via, `service ps ${CONTROLLER_SERVICE} --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`);
    return out.split('\n').find((l) => / Running/.test(l) && !l.startsWith(`${notOn} `));
  }, { timeoutMs, intervalMs: 5000 });
  return ctx.nodeByHostname(line.split(' ')[0]!);
}

/** The controller publishes in host mode: point the harness at its new node, then sign in again. */
export async function followController(ctx: Ctx, node: ClusterNode): Promise<void> {
  const c = ctx.cluster;
  c.controllerUrl = `http://${await c.provider.hostEndpoint(node.name, 3021)}`;
  await poll(`controller healthy on ${node.name}`, () => c.controllerHealthy(), { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  await ctx.connect(ctx.password || undefined);
}

/** The controller container on a node (empty string = none). */
export async function controllerContainer(ctx: Ctx, node: ClusterNode, all = false): Promise<string> {
  const out = await ctx.cluster.mustSh(node, `docker ps ${all ? '-a ' : ''}-q --filter label=com.docker.swarm.service.name=${CONTROLLER_SERVICE} | head -n1`);
  return out.trim();
}

/**
 * iptables that cut a node off from its peers both ways (INPUT from, OUTPUT
 * to every peer address), tagged so `on = false` removes exactly them. The
 * harness reaches nodes over limactl/docker exec, never these addresses.
 * With `on`, it then prints the node's Docker clock (the clock its logs use).
 */
export function partitionScript(peers: string[], on: boolean): string {
  const tag = '-m comment --comment swarmy-e2e-partition';
  const rules = peers.flatMap((p) => [`INPUT -s ${p} ${tag} -j DROP`, `OUTPUT -d ${p} ${tag} -j DROP`]);
  if (!on) return rules.map((r) => `while iptables -D ${r} 2>/dev/null; do :; done`).join('; ') + '; true';
  return `set -e; ${rules.map((r) => `iptables -I ${r}`).join('; ')}; docker info --format '{{.SystemTime}}'`;
}
