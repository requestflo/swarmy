/**
 * The moves the mesh control-plane drill makes (steps/mesh-control-drill.ts):
 * preconditions, picking the three nodes, one `mesh.control.move`, and the
 * move BACK to the node it started on, whose volume still holds its old
 * state. That last one is the path a restore used to get wrong: it kept the
 * old files, so stale peers and setup keys came back.
 */
import type { MoveDrillObservation } from '../../../../packages/mesh/src/control-plane/move-drill';
import type { Ctx } from '../context';
import type { ClusterNode } from './cluster';
import { CONTROLLER_SERVICE, promoteAll } from './controller';
import * as mc from './mesh-control';
import { Skip } from './report';
import { Fatal, assert, log, poll } from './util';

export const ID = 'mesh-control-move';
export const card = (ctx: Ctx) => ctx.q<mc.ControlCard>('mesh.control.status');
export interface Host { id: string; hostname: string; node: ClusterNode; swarmId: string }

export async function prepare(ctx: Ctx): Promise<mc.ControlCard> {
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
export function move(ctx: Ctx, to: Host): Promise<mc.ControlCard> {
  return poll(`mesh.control.move to ${to.hostname} accepted`, () =>
    ctx.m<mc.ControlCard>('mesh.control.move', { nodeId: to.id }, 8 * 60_000).catch((e: Error) => {
      if (/swarm manager/.test(e.message)) return null;
      throw new Fatal(e.message);
    }),
  { timeoutMs: 2 * 60_000, intervalMs: 5000 });
}

/** A (hosts it), B (not the controller's node, preferably not Garage's), C (the third). */
export async function pick(ctx: Ctx, c0: mc.ControlCard): Promise<[Host, Host, Host]> {
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

/**
 * (3) Back to `home`, which hosted the control plane before the first move
 * and still has its files. It must restore the backup over them, keep them
 * aside, and accept a setup key minted while the control plane was away.
 */
export async function moveBack(ctx: Ctx, c0: mc.ControlCard, home: Host, from: Host): Promise<MoveDrillObservation['moveBack']> {
  const keyAway = await mc.mintSetupKey(ctx);
  // Litestream ships every second, and a move's stop kills it without a final sync.
  await new Promise((r) => setTimeout(r, 5000));
  const epochBefore = (await mc.readLease(ctx, home.node))?.epoch ?? null;
  const moved = await move(ctx, home);
  const restore = moved.status?.restore;
  log(`moved ${from.hostname} → ${home.hostname} (back); ${await mc.repointMeshDomain(c0, home.node)}; ${restore?.reason ?? 'no restore report (an older agent?)'}`);
  const c = await poll(`control plane healthy on ${home.hostname} again`, async () => {
    const x = await card(ctx);
    return x.node.id === home.id && x.status?.healthy ? x : null;
  }, { timeoutMs: 5 * 60_000, intervalMs: 5000 });
  const lease = await mc.readLease(ctx, home.node);
  return {
    used: restore?.used ?? null,
    keptOldCopy: restore?.keptAs ? await mc.controlVolumeHas(ctx, home.node, `${restore.keptAs}/store.db`) : false,
    epochBefore,
    epochAfter: lease?.epoch ?? null,
    holderAfter: lease?.holder ?? null,
    target: home.swarmId,
    keyMintedAway: await mc.setupKeyEnrols(ctx, from.node, keyAway, c.managementUrl ?? '', `e2e-nb-back-${ctx.runId}`),
  };
}
