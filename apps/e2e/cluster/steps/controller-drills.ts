/**
 * The two P3 done-gate drills (plans/epic-docker-native-state.md §5 P3).
 * Disruptive, so opt-in: `--enable controller-drain,controller-partition`.
 * Both promote every node to a manager and replicate control.db to Garage.
 *
 *  controller-drain      drain the controller's node: the task starts on
 *                        another manager, restores from Garage, agents
 *                        re-adopt, and the write made just before the drain
 *                        is still there.
 *  controller-partition  cut the controller's node off from its peers: it
 *                        self-fences (exit 70) inside the lease window, a new
 *                        controller takes the lease only after that, and a
 *                        write replicated before the cut survives.
 */
import { fenceBoundMs, judgeFenceDrill, logLineAt, parseDockerTime } from '../../../api/src/controller-store/fence-drill';
import type { Ctx } from '../context';
import { restClient } from '../lib/api';
import {
  CONTROLLER_SERVICE as SVC,
  controllerContainer,
  controllerMovedOff,
  dockerOn,
  ensureReplicated,
  followController,
  partitionScript,
  promoteAll,
  waitCaughtUp,
  type StoreStatus,
} from '../lib/controller';
import { Skip } from '../lib/report';
import { assert, log, poll, secret } from '../lib/util';

const sec = (ms: number) => `${Math.round(ms / 1000)}s`;

async function prepare(ctx: Ctx, id: string): Promise<StoreStatus> {
  if (!ctx.opts.enable.includes(id)) throw new Skip(`flagged off: disruptive, run with --enable ${id}`);
  if (!(await ctx.session.hasProcedure('controllerStore.status'))) throw new Skip('no controllerStore in this build');
  if (ctx.cluster.nodes.length < 3) throw new Skip('needs 3 nodes (3 managers keep raft quorum through the drill)');
  await promoteAll(ctx);
  return ensureReplicated(ctx);
}

/** A control.db write (an API key, not swarm-kv), so its survival proves the replica carried it. */
async function markerKey(ctx: Ctx, what: string): Promise<{ id: string; key: string }> {
  const k = await ctx.m<{ id: string; key: string }>('apiKeys.create', { name: `e2e-${what}-${ctx.runId}`, preset: 'read' });
  return { id: k.id, key: secret(k.key) };
}

async function allOnline(ctx: Ctx): Promise<number> {
  const rows = await poll('every node online (agents re-adopted)', async () => {
    const { data } = await ctx.sdk.nodes.list({ limit: 100 });
    return data.length > 0 && data.every((n) => n.status === 'online') ? data : null;
  }, { timeoutMs: 6 * 60_000, intervalMs: 5000 });
  return rows.length;
}

export async function controllerDrain(ctx: Ctx) {
  const before = await prepare(ctx, 'controller-drain');
  const from = await ctx.nodeByHostname(before.hostname);
  const via = ctx.cluster.nodes.find((n) => n !== from)!;
  const marker = await markerKey(ctx, 'drain'); // the LAST write before the drain: no wait
  const t0 = Date.now();
  await dockerOn(ctx, via, `node update --availability drain ${before.hostname}`);
  try {
    const to = await controllerMovedOff(ctx, via, before.hostname);
    await followController(ctx, to);
    const movedIn = sec(Date.now() - t0);
    const after = await ctx.q<StoreStatus>('controllerStore.status');
    assert(after.boot?.kind === 'restore-replica', `boot on ${after.hostname}: ${after.boot?.kind} (${after.boot?.outcome}); want a restore from Garage`);
    assert((after.epoch ?? 0) > (before.epoch ?? 0), `lease epoch ${before.epoch} → ${after.epoch}`);
    await restClient(ctx.url, marker.key).nodes.list({ limit: 1 }); // throws if the key was lost
    const online = await allOnline(ctx);
    return `drained ${before.hostname} → controller on ${after.hostname} in ${movedIn} (${after.boot.outcome}); epoch ${before.epoch} → ${after.epoch}; the key written just before the drain works; ${online} nodes online`;
  } finally {
    await dockerOn(ctx, via, `node update --availability active ${before.hostname}`).catch(() => {});
    await ctx.m('apiKeys.revoke', { id: marker.id }).catch(() => {});
  }
}

export async function controllerPartition(ctx: Ctx) {
  const c = ctx.cluster;
  await prepare(ctx, 'controller-partition');
  const marker = await markerKey(ctx, 'partition');
  const before = await waitCaughtUp(ctx); // the marker is in the replica before the cut
  const old = await ctx.nodeByHostname(before.hostname);
  const peers = c.nodes.filter((n) => n !== old);
  const via = peers[0]!;
  const oldCid = await controllerContainer(ctx, old);
  assert(oldCid, `no controller container on ${old.name}`);
  const addrs = [...new Set(peers.flatMap((n) => [n.ip, n.fabricIp]).filter(Boolean))];
  let healed = false;
  const heal = () => c.mustSh(old, partitionScript(addrs, false), {}, `${old.name}: heal partition`);
  const partitionAt = parseDockerTime(await c.mustSh(old, partitionScript(addrs, true), {}, `${old.name}: partition`));
  assert(Number.isFinite(partitionAt), `${old.name}: could not read the node's clock after the partition`);
  log(`${old.name} (${before.hostname}) cut off from ${addrs.join(', ')} at ${new Date(partitionAt).toISOString()}`);
  try {
    // 1. The cut-off controller fences itself.
    const fence = await poll('the cut-off controller exits 70 (fenced)', async () => {
      const st = (await c.mustSh(old, `docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' ${oldCid}`)).trim();
      if (!st.startsWith('exited')) return null;
      const logs = await c.mustSh(old, `docker logs --timestamps ${oldCid} 2>&1 | grep -F 'controller store: FENCED' | head -n1; true`);
      return { exitCode: Number(st.split(' ')[1]), fenced: logLineAt(logs, /FENCED/) };
    }, { timeoutMs: fenceBoundMs() + 60_000, intervalMs: 2000 });
    // 2. The majority side starts a new controller, which waits out the lease.
    const nu = await controllerMovedOff(ctx, via, before.hostname);
    const took = await poll(`new controller on ${nu.name} holds the lease`, async () => {
      const cid = await controllerContainer(ctx, nu);
      if (!cid) return null;
      return logLineAt(await c.mustSh(nu, `docker logs --timestamps ${cid} 2>&1 | grep -F 'lease acquired' | tail -n1; true`), /lease acquired \(epoch \d+\)/);
    }, { timeoutMs: 6 * 60_000, intervalMs: 3000 });
    const newEpoch = Number(/epoch (\d+)/.exec(took.line)?.[1]);
    const v = judgeFenceDrill({ partitionAt, fencedAt: fence.fenced?.at ?? null, exitCode: fence.exitCode, takeoverAt: took.at, oldEpoch: before.epoch, newEpoch });
    assert(v.ok, v.problems.join('; '));
    // 3. What was replicated before the cut survived.
    await followController(ctx, nu);
    const after = await ctx.q<StoreStatus>('controllerStore.status');
    assert(after.boot?.kind === 'restore-replica', `boot on ${after.hostname}: ${after.boot?.kind}; want a restore from Garage`);
    await restClient(ctx.url, marker.key).nodes.list({ limit: 1 });
    // 4. Heal: the old node comes back and does not start a second controller.
    await heal();
    healed = true;
    await poll(`${before.hostname} Ready again`, async () =>
      (await dockerOn(ctx, via, `node ls --format '{{.Hostname}} {{.Status}}'`)).split('\n').includes(`${before.hostname} Ready`),
    { timeoutMs: 5 * 60_000, intervalMs: 5000 });
    await Bun.sleep(20_000);
    const running = (await dockerOn(ctx, via, `service ps ${SVC} --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`)).split('\n').filter((l) => / Running/.test(l));
    assert(running.length === 1 && running[0]!.startsWith(`${after.hostname} `), `controller tasks after heal: ${running.join(' | ') || 'none'}`);
    assert(!(await controllerContainer(ctx, old)), `a controller container is running again on ${old.name}`);
    const target = v.meetsEpicTarget ? 'meets' : 'misses (TTL 60 s since QA-022)';
    return `fenced ${sec(v.fencedAfterMs!)} after the cut (design bound ${sec(fenceBoundMs())}; ${target} the epic's 30 s); ${after.hostname} took the lease ${sec(v.handoverGapMs!)} later at epoch ${newEpoch}; pre-cut write intact; one controller after heal`;
  } finally {
    if (!healed) await heal().catch(() => {});
    await ctx.m('apiKeys.revoke', { id: marker.id }).catch(() => {});
  }
}
