/**
 * Helpers for the mesh control-plane move drill (steps/mesh-control-drill.ts):
 * the lease as raft has it, container states on a node (Docker's own clock),
 * every node's NetBird client, a throwaway client that enrols with a setup
 * key, and re-pointing the mesh domain.
 */
import type { Ctx } from '../context';
import type { ClusterNode } from './cluster';
import { dockerOn } from './controller';
import { assert, log, poll, q, secret } from './util';

export const MESH_CONTROL = 'swarmy-mesh-control';
export const MESH_LITESTREAM = 'swarmy-mesh-litestream';
/** Kept in sync with @swarmy/core/protocol mesh-control-lease.ts (no workspace imports here). */
const LEASE_CONFIG = 'swarmy-mesh-control-lease';
const LEASE_LABEL = 'swarmy.mesh.control.lease';

/** What the drill reads off `mesh.control.status` (ControlPlaneCardView). */
export interface ControlCard {
  managed: boolean;
  meshDomain: string | null;
  managementUrl: string | null;
  tls: string | null;
  node: { id: string | null; hostname: string | null; online: boolean };
  status: { running: boolean; healthy: boolean; restored?: boolean; lease?: { state: string; epoch?: number; replicate?: boolean } } | null;
  backup: { configured: boolean; running: boolean };
}

export interface Lease {
  holder: string;
  hostname?: string;
  epoch: number;
  released?: boolean;
}

/** The lease label, read through a manager with quorum (null = none yet). */
export async function readLease(ctx: Ctx, via: ClusterNode): Promise<Lease | null> {
  const out = await dockerOn(ctx, via, `config inspect ${LEASE_CONFIG} --format '{{index .Spec.Labels "${LEASE_LABEL}"}}' 2>/dev/null || true`);
  return out.trim() ? (JSON.parse(out.trim()) as Lease) : null;
}

/** The swarm node id of a node (what the lease names as holder). */
export async function swarmIdOf(ctx: Ctx, node: ClusterNode): Promise<string> {
  return (await dockerOn(ctx, node, `info --format '{{.Swarm.NodeID}}'`)).trim();
}

export interface Box {
  running: boolean;
  startedAt: number;
  finishedAt: number;
  exitCode: number;
}

/** A container's state on a node, timestamps on that node's clock (null = no such container). */
export async function containerState(ctx: Ctx, node: ClusterNode, name: string): Promise<Box | null> {
  const out = (await ctx.cluster.mustSh(node, `docker inspect -f '{{.State.Running}} {{.State.StartedAt}} {{.State.FinishedAt}} {{.State.ExitCode}}' ${name} 2>/dev/null || true`)).trim();
  if (!out) return null;
  const [running, started, finished, code] = out.split(' ');
  const t = (x?: string) => Date.parse((x ?? '').replace(/(\.\d{3})\d+/, '$1'));
  return { running: running === 'true', startedAt: t(started), finishedAt: t(finished), exitCode: Number(code) };
}

/** Nodes running a control plane right now. */
export async function controlPlanesRunning(ctx: Ctx): Promise<ClusterNode[]> {
  const out: ClusterNode[] = [];
  for (const n of ctx.cluster.nodes) if ((await containerState(ctx, n, MESH_CONTROL))?.running) out.push(n);
  return out;
}

/** Every node's own NetBird client has management and signal back (polled until all do, or the timeout). */
export async function peersReattached(ctx: Ctx, timeoutMs = 5 * 60_000): Promise<{ total: number; connected: number }> {
  const total = ctx.cluster.nodes.length;
  let connected = 0;
  await poll('every node\'s NetBird client re-attached (management + signal)', async () => {
    connected = 0;
    for (const n of ctx.cluster.nodes) {
      const st = await ctx.cluster.mustSh(n, 'docker exec swarmy-netbird netbird status 2>/dev/null || true');
      if (/Management: Connected/.test(st) && /Signal: Connected/.test(st)) connected++;
    }
    return connected === total;
  }, { timeoutMs, intervalMs: 5000 }).catch((e) => log(`peers: ${(e as Error).message}`));
  return { total, connected };
}

/** A fresh single-use setup key (inside a join token, as Add a node hands out). */
export async function mintSetupKey(ctx: Ctx): Promise<string> {
  const tok = await ctx.m<{ meshSetupKey?: string }>('nodes.generateJoinToken', { ttlSeconds: 3600, maxUses: 1, label: `e2e-mesh-move-${ctx.runId}` });
  assert(tok.meshSetupKey, 'the join token carries no mesh setup key (is the mesh on?)');
  return secret(tok.meshSetupKey);
}

/**
 * Does `key` still enrol a peer? A throwaway NetBird client (the node's own
 * client image, its own netns) logs in with it and must reach management.
 * The key rides stdin, never argv. The probe peer stays listed in NetBird.
 */
export async function setupKeyEnrols(ctx: Ctx, node: ClusterNode, key: string, managementUrl: string, name: string): Promise<boolean> {
  const c = ctx.cluster;
  const image = (await c.mustSh(node, `docker inspect -f '{{.Config.Image}}' swarmy-netbird`)).trim();
  await c.mustSh(node, `docker rm -f ${name} >/dev/null 2>&1; docker run -d --name ${name} --hostname ${name} --label swarmy.test=mesh-control-move \\
  --cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE --device /dev/net/tun --entrypoint netbird ${q(image)} service run >/dev/null`);
  try {
    // With a setup key `netbird up` logs in and returns (no browser step).
    const inner = `read -r NB_SETUP_KEY; export NB_SETUP_KEY; netbird up --management-url ${q(managementUrl)}`;
    const up = await c.sh(node, `docker exec -i ${name} sh -c ${q(inner)}`, {
      input: `${key}\n`,
      timeoutMs: 120_000,
    });
    if (up.code !== 0) {
      log(`${name}: netbird up exited ${up.code}: ${(up.stderr || up.stdout).trim().split('\n').slice(-2).join(' ')}`);
      return false;
    }
    return await poll(`${name} enrols with its setup key`, async () => /Management: Connected/.test(await c.mustSh(node, `docker exec ${name} netbird status 2>/dev/null || true`)), {
      timeoutMs: 120_000,
      intervalMs: 3000,
    }).catch(() => false);
  } finally {
    await c.mustSh(node, `docker rm -f ${name} >/dev/null 2>&1; true`).catch(() => {});
  }
}

/**
 * Point the mesh domain at `node`. Behind swarmy's edge nothing changes (the
 * name answers with the edges and Caddy's upstream follows the control node).
 * Otherwise SWARMY_E2E_MESH_REPOINT runs here with {host} and {ip} filled in.
 */
export async function repointMeshDomain(card: ControlCard, node: ClusterNode): Promise<string> {
  if (card.tls === 'edge') return 'served by the edge (nothing to re-point)';
  const cmd = process.env.SWARMY_E2E_MESH_REPOINT ?? '';
  const ip = node.fabricIp || node.ip;
  const r = Bun.spawnSync(['sh', '-c', cmd.replaceAll('{host}', card.meshDomain ?? '').replaceAll('{ip}', ip)], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`SWARMY_E2E_MESH_REPOINT failed (${r.exitCode}): ${r.stderr.toString().slice(0, 300)}`);
  return `${card.meshDomain} → ${ip}`;
}
