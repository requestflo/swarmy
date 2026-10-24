/**
 * The mesh control-plane move drill (plans/epic-self-hosted-mesh-and-fleets.md
 * §2.5). Disruptive, so opt-in: `--enable mesh-control-move` on a
 * `--mesh swarmy` cluster of 3 nodes. Every node becomes a manager: only a
 * manager can hold the lease, and 3 keep raft quorum through the partition.
 *
 *  1. clean move A → B (`mesh.control.move`): B restores from the replica and
 *     holds the lease, A runs nothing, every node's client re-attaches, and a
 *     setup key minted before the move and one minted after both enrol.
 *  2. partition B (the old node of a second move) and move to C: B can't renew
 *     and kills its Litestream inside the lease window, C takes over only
 *     after a full TTL (one replica writer at a time), and after the heal B
 *     sees C's lease and stops. Judged by judgeMoveDrill (pure, tested).
 *
 * The mesh domain must follow the control plane: never *.sslip.io (a move is
 * refused there). Behind swarmy's edge it follows by itself; a directly served
 * name needs SWARMY_E2E_MESH_REPOINT='<command using {host} {ip}>'.
 */
import { judgeMoveDrill } from '../../../../packages/mesh/src/control-plane/move-drill';
import { parseDockerTime } from '../../../api/src/controller-store/fence-drill';
import type { Ctx } from '../context';
import type { ClusterNode } from '../lib/cluster';
import { CONTROLLER_SERVICE, dockerOn, partitionScript, promoteAll } from '../lib/controller';
import * as mc from '../lib/mesh-control';
import { Skip } from '../lib/report';
import { Fatal, assert, log, poll } from '../lib/util';

const ID = 'mesh-control-move';
const card = (ctx: Ctx) => ctx.q<mc.ControlCard>('mesh.control.status');
interface Host { id: string; hostname: string; node: ClusterNode; swarmId: string }

async function prepare(ctx: Ctx): Promise<mc.ControlCard> {
  if (!ctx.opts.enable.includes(ID)) throw new Skip(`flagged off: disruptive, run with --enable ${ID}`);
  if (ctx.cluster.cfg.mesh !== 'swarmy') throw new Skip('needs --mesh swarmy (the self-hosted control plane)');
  if (ctx.cluster.nodes.length < 3) throw new Skip('needs 3 nodes (3 managers keep raft quorum through the partition)');
  if (!(await ctx.session.hasProcedure('mesh.control.status'))) throw new Skip('no mesh.control in this build');
  const c0 = await card(ctx);
  if (!c0.managed) throw new Skip('the mesh control plane is not managed by swarmy');
  if (!c0.meshDomain || c0.meshDomain.endsWith('.sslip.io')) throw new Skip(`${c0.meshDomain} pins one IP, so a move is refused: install with --mesh-domain <a name you can re-point>`);
  if (c0.tls !== 'edge' && !process.env.SWARMY_E2E_MESH_REPOINT) throw new Skip(`${c0.meshDomain} is served directly (${c0.tls}): set SWARMY_E2E_MESH_REPOINT to re-point it`);
  await promoteAll(ctx);
  // A move restores from Litestream: object storage on, the replica shipping, the lease held.
  await ctx.m('storage.enable', undefined, 5 * 60_000).catch((e) => {
    if (!/already/i.test((e as Error).message)) throw e;
  });
  return poll('control plane backed up, healthy and under its lease', async () => {
    await ctx.m('mesh.control.reconcile').catch(() => {});
    const c = await card(ctx);
    return c.backup.running && c.status?.healthy && c.status.lease?.state === 'held' ? c : null;
  }, { timeoutMs: 10 * 60_000, intervalMs: 10_000 });
}

/** `mesh.control.move`, retried only while the hub hasn't seen a fresh promotion yet. */
function move(ctx: Ctx, to: Host): Promise<mc.ControlCard> {
  return poll(`mesh.control.move to ${to.hostname} accepted`, () =>
    ctx.m<mc.ControlCard>('mesh.control.move', { nodeId: to.id }, 8 * 60_000).catch((e: Error) => {
      if (/swarm manager/.test(e.message)) return null;
      throw new Fatal(e.message);
    }),
  { timeoutMs: 2 * 60_000, intervalMs: 5000 });
}

/** A (hosts it), B (not the controller's node, preferably not Garage's), C (the third). */
async function pick(ctx: Ctx, c0: mc.ControlCard): Promise<[Host, Host, Host]> {
  const hs: Host[] = [];
  for (const r of (await ctx.sdk.nodes.list({ limit: 100 })).data) {
    const node = await ctx.nodeByHostname(r.hostname);
    hs.push({ id: r.id, hostname: r.hostname, node, swarmId: await mc.swarmIdOf(ctx, node) });
  }
  const ctl = (await ctx.task(CONTROLLER_SERVICE)).node;
  const garage = (await ctx.docker(`service ps swarmy-garage --filter desired-state=running --format '{{.Node}}'`).catch(() => '')).split('\n');
  const a = hs.find((h) => h.id === c0.node.id);
  const cands = hs.filter((h) => h !== a && h.node !== ctl);
  const b = cands.find((h) => !garage.includes(h.hostname)) ?? cands[0];
  const c = hs.find((h) => h !== a && h !== b);
  assert(a && b && c, `need three nodes: the host, a non-controller node, a third (have ${hs.map((h) => h.hostname).join(', ')})`);
  if (c0.tls !== 'edge' && (b.node.natted || c.node.natted)) throw new Skip('a directly served mesh name cannot move behind the simulated NAT (peers could not dial it)');
  return [a, b, c];
}

export async function meshControlMove(ctx: Ctx) {
  const c = ctx.cluster;
  const c0 = await prepare(ctx);
  const [A, B, C] = await pick(ctx, c0);

  // ── 1. the clean move A → B ──────────────────────────────────────────────
  const keyBefore = await mc.mintSetupKey(ctx);
  const e0 = (await mc.readLease(ctx, B.node))?.epoch ?? null;
  const moved = await move(ctx, B);
  log(`moved ${A.hostname} → ${B.hostname}; ${await mc.repointMeshDomain(c0, B.node)}`);
  const c1 = await poll(`control plane healthy on ${B.hostname}`, async () => {
    const x = await card(ctx);
    return x.node.id === B.id && x.status?.healthy ? x : null;
  }, { timeoutMs: 5 * 60_000, intervalMs: 5000 });
  const l1 = await mc.readLease(ctx, B.node);
  const oldStillRuns = !!(await mc.containerState(ctx, A.node, mc.MESH_CONTROL))?.running;
  const peers = await mc.peersReattached(ctx);
  const url = c1.managementUrl ?? '';
  const mintedBefore = await mc.setupKeyEnrols(ctx, C.node, keyBefore, url, `e2e-nb-before-${ctx.runId}`);
  const mintedAfter = await mc.setupKeyEnrols(ctx, C.node, await mc.mintSetupKey(ctx), url, `e2e-nb-after-${ctx.runId}`);

  // ── 2. partition B, move to C ────────────────────────────────────────────
  await poll(`${B.hostname} replicating`, async () => (await mc.containerState(ctx, B.node, mc.MESH_LITESTREAM))?.running, { timeoutMs: 5 * 60_000 });
  const e1 = (await mc.readLease(ctx, B.node))?.epoch ?? null;
  const addrs = [...new Set(c.nodes.filter((n) => n !== B.node).flatMap((n) => [n.ip, n.fabricIp]).filter(Boolean))];
  const heal = () => c.mustSh(B.node, partitionScript(addrs, false), {}, `${B.node.name}: heal partition`);
  const partitionAt = parseDockerTime(await c.mustSh(B.node, partitionScript(addrs, true), {}, `${B.node.name}: partition`));
  assert(Number.isFinite(partitionAt), `${B.node.name}: could not read the node's clock after the partition`);
  let healed = false;
  try {
    // moveControlPlane stops only nodes it sees online: wait until B looks dark.
    await poll(`the controller sees ${B.hostname} offline`, async () => (await ctx.sdk.nodes.list({ limit: 100 })).data.find((n) => n.id === B.id)?.status !== 'online', {
      timeoutMs: 3 * 60_000,
      intervalMs: 5000,
    });
    await move(ctx, C); // C waits out B's lease (a full TTL)
    log(`moved ${B.hostname} (cut off) → ${C.hostname}; ${await mc.repointMeshDomain(c0, C.node)}`);
    const dead = async () => {
      const x = await mc.containerState(ctx, B.node, mc.MESH_LITESTREAM);
      return x && !x.running ? x : null;
    };
    const oldLs = await poll(`${B.hostname} kills its Litestream (self-fence)`, dead, { timeoutMs: 3 * 60_000, intervalMs: 2000 }).catch(() => null);
    const live = async () => {
      const x = await mc.containerState(ctx, C.node, mc.MESH_LITESTREAM);
      return x?.running ? x : null;
    };
    const newLs = await poll(`${C.hostname} replicating`, live, { timeoutMs: 5 * 60_000 }).catch(() => null);
    const l2 = await mc.readLease(ctx, C.node);
    const servedWhileCut = !!(await mc.containerState(ctx, B.node, mc.MESH_CONTROL))?.running;
    await heal();
    healed = true;
    await poll(`${B.hostname} Ready again`, async () => (await dockerOn(ctx, C.node, `node ls --format '{{.Hostname}} {{.Status}}'`)).split('\n').includes(`${B.hostname} Ready`), {
      timeoutMs: 5 * 60_000,
      intervalMs: 5000,
    });
    const gone = async () => !(await mc.containerState(ctx, B.node, mc.MESH_CONTROL))?.running;
    const oldStopped = await poll(`${B.hostname} stops (it sees ${C.hostname}'s lease)`, gone, { timeoutMs: 2 * 60_000 }).catch(() => false);
    const running = await mc.controlPlanesRunning(ctx);
    const after = await mc.peersReattached(ctx);
    const v = judgeMoveDrill({
      cleanMove: { restored: moved.status?.restored ?? null, epochBefore: e0, epochAfter: l1?.epoch ?? null, holderAfter: l1?.holder ?? null, target: B.swarmId, oldStillRuns },
      peers,
      setupKeys: { mintedBefore, mintedAfter },
      partition: {
        partitionAt,
        oldReplicaStoppedAt: oldLs?.finishedAt ?? null,
        oldReplicaExit: oldLs?.exitCode ?? null,
        newReplicaStartedAt: newLs?.startedAt ?? null,
        epochBefore: e1,
        epochAfter: l2?.epoch ?? null,
        holderAfter: l2?.holder ?? null,
        target: C.swarmId,
        oldStoppedAfterHeal: oldStopped,
        controlPlanesAfterHeal: running.length,
      },
    });
    assert(v.ok, v.problems.join('; '));
    assert(after.connected === after.total, `after the heal: ${after.connected}/${after.total} peers re-attached`);
    const sec = (ms: number | null) => `${Math.round((ms ?? 0) / 1000)}s`;
    return `${A.hostname} → ${B.hostname} (epoch ${e0} → ${l1?.epoch}), ${peers.connected}/${peers.total} peers back, setup keys enrol; cut ${B.hostname}: Litestream killed ${sec(v.fencedAfterMs)} after the cut${servedWhileCut ? ' (NetBird kept serving, as designed)' : ''}, ${C.hostname} replicating ${sec(v.handoverGapMs)} later (epoch ${e1} → ${l2?.epoch}); one control plane after the heal`;
  } finally {
    if (!healed) await heal().catch(() => {});
  }
}
