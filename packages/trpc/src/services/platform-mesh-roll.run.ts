/**
 * The upgrade's mesh step as it runs (rules: `platform-mesh-roll.ts`).
 * Resumable: per-server progress, the image each ran before and its mesh IP
 * live in the step's `data`, so a controller restart re-checks the server it
 * was on instead of moving it twice. Rollback (and Abandon) moves every
 * server it changed back to its previous image, newest first, one at a time.
 */
import { AGENT_CAPABILITY, agentSupports, type ReimageMeshResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { meshPeers } from './mesh-peers';
import { NETBIRD_CONTAINER, meshGuard, meshNodeBack, onTarget, planMeshRoll, type MeshNodeObs } from './platform-mesh-roll';
import type { ManifestComponentLite, StepContext, StepOutcome } from './platform-upgrade.plan';

export interface MeshRollIO {
  /** Every server, oldest first. */
  observe: () => Promise<MeshNodeObs[]>;
  reimage: (nodeId: string, image: string) => Promise<ReimageMeshResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface MeshRollData {
  to?: string;
  digest?: string;
  nodes?: Record<string, 'dispatched' | 'moved' | 'skipped'>;
  from?: Record<string, string>;
  ipBefore?: Record<string, string | null>;
  at?: Record<string, number>;
}

const OPTS = { pollMs: 5_000, settleMs: 3 * 60_000, guardMs: 3 * 60_000 };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Wait until taking `id` down leaves someone else on the mesh. */
async function guarded(c: StepContext, io: MeshRollIO, id: string, name: string, o: typeof OPTS): Promise<MeshNodeObs[]> {
  const until = io.now() + o.guardMs;
  for (;;) {
    const nodes = await io.observe();
    if (!nodes.find((x) => x.id === id)?.online) throw new Error(`${name} went offline before its mesh client could move`);
    const why = meshGuard(nodes, id);
    if (!why) return nodes;
    if (io.now() > until) throw new Error(`${name}: ${why} — not taking the last one down`);
    c.step.detail = `${name}: waiting — ${why}`;
    await io.sleep(o.pollMs);
  }
}

export async function rollMesh(c: StepContext, target: ManifestComponentLite | undefined, io: MeshRollIO, o = OPTS): Promise<StepOutcome> {
  if (!target?.digest) return { status: 'skipped', detail: 'this release names no mesh client build' };
  const d = (c.step.data ??= {}) as MeshRollData;
  d.to ??= `${target.ref}@${target.digest}`;
  d.digest ??= target.digest;
  d.nodes ??= {};
  d.from ??= {};
  d.ipBefore ??= {};
  d.at ??= {};
  const t = { to: d.to, digest: d.digest };
  const first = await io.observe();
  if (!first.some((n) => n.sidecar)) return { status: 'skipped', detail: 'no server runs a mesh client' };
  let moved = 0;
  for (const p of planMeshRoll(first, t)) {
    const st = d.nodes[p.id];
    if (st === 'moved' || st === 'skipped') continue;
    if (st !== 'dispatched') {
      if (p.action === 'skip') {
        d.nodes[p.id] = 'skipped';
        if (p.why !== 'no mesh client' && p.why !== 'already on this release') c.note(`${p.name}: mesh client left as it is (${p.why})`);
        continue;
      }
      const n = (await guarded(c, io, p.id, p.name, o)).find((x) => x.id === p.id)!;
      Object.assign(d, { from: { ...d.from, [p.id]: n.sidecar! }, ipBefore: { ...d.ipBefore, [p.id]: n.peer?.meshIp ?? null }, at: { ...d.at, [p.id]: io.now() } });
      d.nodes[p.id] = 'dispatched';
      c.step.detail = `${p.name}: moving its mesh client`;
      await c.checkpoint();
      try {
        const r = await io.reimage(p.id, t.to);
        if (!r.changed && r.reason === 'no-client') {
          d.nodes[p.id] = 'skipped';
          await c.checkpoint();
          continue;
        }
      } catch (e) {
        // A lost answer (this server's link rides the mesh) is judged by what we see next;
        // anything else is the agent's verdict, and it already put the old client back.
        if (!/timeout/i.test(msg(e))) {
          delete d.nodes[p.id];
          await c.checkpoint();
          throw new Error(`${p.name}: ${msg(e)}`);
        }
      }
    }
    const until = io.now() + o.settleMs;
    for (;;) {
      const back = meshNodeBack((await io.observe()).find((x) => x.id === p.id), t, d.at[p.id] ?? 0, d.ipBefore[p.id] ?? null);
      if (back.ok) break;
      if (io.now() > until) throw new Error(`${p.name}: the mesh client did not come back on the new build (${back.why})`);
      c.step.detail = `${p.name}: ${back.why}`;
      await io.sleep(o.pollMs);
    }
    d.nodes[p.id] = 'moved';
    moved++;
    c.note(`${p.name}: back on the private network with the new mesh client`);
    await c.checkpoint();
  }
  return { status: 'done', detail: moved ? `${moved} server(s) on the new mesh client, one at a time` : 'every mesh client already runs this release' };
}

/** Put every client this step moved back on its previous image, newest first. */
export async function rollMeshBack(c: StepContext, io: MeshRollIO, o = OPTS): Promise<string> {
  const d = (c.step.data ??= {}) as MeshRollData;
  const touched = Object.entries(d.nodes ?? {}).filter(([, s]) => s !== 'skipped').map(([id]) => id).reverse();
  if (!touched.length || !d.to || !d.digest) return 'no mesh client was moved';
  const t = { to: d.to, digest: d.digest };
  const back: string[] = [];
  const stuck: string[] = [];
  for (const id of touched) {
    const n = (await io.observe()).find((x) => x.id === id);
    const prev = d.from?.[id];
    if (n && !onTarget(n.sidecar, t)) {
      delete d.nodes![id];
      continue;
    }
    if (!n || !prev || !n.online) {
      stuck.push(n?.name ?? id);
      continue;
    }
    try {
      await guarded(c, io, id, n.name, o);
      await io.reimage(id, prev);
      delete d.nodes![id];
      back.push(n.name);
    } catch (e) {
      stuck.push(`${n.name} (${msg(e)})`);
    }
    await c.checkpoint();
  }
  if (stuck.length) throw new Error(`could not put the previous mesh client back on ${stuck.join(', ')}`);
  return back.length ? `${back.join(', ')}: mesh client back on the previous build` : 'no mesh client needed putting back';
}

export function meshRollIO(ctx: OrgContext): MeshRollIO {
  return {
    observe: async () => {
      const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
      return nodes.map((n) => {
        const sidecar = ctx.hub.latestContainers(n.id).find((x) => x.name.replace(/^\//, '') === NETBIRD_CONTAINER);
        const peer = meshPeers.get(n.id);
        return {
          id: n.id,
          name: n.name,
          online: ctx.hub.isOnline(n.id),
          supports: agentSupports(ctx.hub.agentBuildFor?.(n.id)?.capabilities, AGENT_CAPABILITY.reimageMesh),
          sidecar: sidecar?.image ?? null,
          peer: peer ? { status: peer.status, meshIp: peer.meshIp, lastSeen: peer.lastSeen?.getTime() ?? null } : null,
        };
      });
    },
    reimage: (id, image) => ctx.hub.dispatch<ReimageMeshResult>(id, 'mesh.reimage', { image }, { timeoutMs: 5 * 60_000 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
