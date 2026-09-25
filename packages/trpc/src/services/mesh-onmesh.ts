/**
 * Which servers run the swarm over the mesh (advertise on their mesh IP). Used
 * to refuse turning the mesh off under them: a swarm joins over the mesh only
 * at install time (`--mesh swarmy`); moving a running swarm on or off the mesh
 * means reinstalling that server.
 */
import type { OrgContext } from '../context';
import { meshPeers } from './mesh-peers';

/** CGNAT range NetBird / Headscale hand out (100.64.0.0/10). */
export function isMeshCidr(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr.trim());
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** Is a swarm advertise address (`host[:port]`) on the mesh? */
export function isOnMesh(addr: string | null | undefined, meshIp: string | null | undefined): boolean {
  const host = addr ? addr.replace(/:\d+$/, '') : '';
  if (!host) return false;
  if (meshIp && host === meshIp) return true;
  return isMeshCidr(host);
}

/** Hostnames of the org's servers whose swarm advertise address is on the mesh. */
export async function nodesOnMesh(ctx: OrgContext): Promise<string[]> {
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, hostname: true },
  })) as { id: string; hostname: string }[];
  return rows
    .filter((r) => isOnMesh(ctx.hub.nodeInfoFor(r.id)?.addr, meshPeers.get(r.id)?.meshIp ?? null))
    .map((r) => r.hostname)
    .sort();
}
