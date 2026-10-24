/**
 * The upgrade's mesh step (plans/epic-platform-upgrades.md §2.4: "NetBird
 * sidecars (per node; identity persists in its volume, so mesh IPs don't
 * change)"). Pure — the runner is `platform-mesh-roll.run.ts`.
 *
 * Each server's NetBird client (`swarmy-netbird`) moves to the release's
 * image ONE SERVER AT A TIME (`mesh.reimage`; the agent puts the old client
 * back itself if the new one doesn't reconnect). A server is only touched
 * while another server is on the mesh, so the whole private network is never
 * down at once, and the next server waits until the controller sees this one
 * back: online, its client on the new build, and a fresh `meshState` saying
 * CONNECTED with the same mesh IP as before.
 */
import { digestOf } from './platform-upgrade.plan';

export const NETBIRD_CONTAINER = 'swarmy-netbird';

export interface MeshPeerObs {
  status: string;
  meshIp: string | null;
  lastSeen: number | null;
}

/** What the controller sees of one server right now. */
export interface MeshNodeObs {
  id: string;
  name: string;
  online: boolean;
  /** Its agent advertises `reimageMesh`. */
  supports: boolean;
  /** The live `swarmy-netbird` container image; null = no NetBird client there. */
  sidecar: string | null;
  peer: MeshPeerObs | null;
}

export type MeshNodePlan = { id: string; name: string; action: 'roll' } | { id: string; name: string; action: 'skip'; why: string };

export function onTarget(image: string | null, target: { to: string; digest: string }): boolean {
  return Boolean(image && (image === target.to || digestOf(image) === target.digest));
}

const connected = (n: MeshNodeObs) => n.peer?.status === 'CONNECTED';

/** Which servers' clients move, in order, and why the others don't. Pure. */
export function planMeshRoll(nodes: readonly MeshNodeObs[], target: { to: string; digest: string }): MeshNodePlan[] {
  return nodes.map((n) => {
    if (!n.sidecar) return { id: n.id, name: n.name, action: 'skip', why: 'no mesh client' };
    if (onTarget(n.sidecar, target)) return { id: n.id, name: n.name, action: 'skip', why: 'already on this release' };
    if (!n.supports) return { id: n.id, name: n.name, action: 'skip', why: 'its agent is too old to move the mesh client' };
    if (n.online && !connected(n)) return { id: n.id, name: n.name, action: 'skip', why: 'its mesh was already down; left as it is' };
    return { id: n.id, name: n.name, action: 'roll' };
  });
}

/**
 * Never take every server's mesh down at once: before `id` goes, another
 * server with a mesh client must be connected (a single-server mesh has no
 * other, and goes alone). Null = go; else why to wait. Pure.
 */
export function meshGuard(nodes: readonly MeshNodeObs[], id: string): string | null {
  const others = nodes.filter((n) => n.id !== id && n.sidecar);
  if (!others.length || others.some(connected)) return null;
  return 'no other server is on the private network right now';
}

/** Is `n` back after its client was moved at `dispatchedAt`? Pure. */
export function meshNodeBack(
  n: MeshNodeObs | undefined,
  target: { to: string; digest: string },
  dispatchedAt: number,
  ipBefore: string | null,
): { ok: true } | { ok: false; why: string } {
  if (!n?.online) return { ok: false, why: 'the server is not connected to swarmy' };
  if (!onTarget(n.sidecar, target)) return { ok: false, why: 'its mesh client is not on the new build yet' };
  if (!connected(n) || (n.peer?.lastSeen ?? 0) <= dispatchedAt) return { ok: false, why: 'waiting for it to report the mesh connected' };
  if (ipBefore && n.peer?.meshIp && n.peer.meshIp !== ipBefore) return { ok: false, why: `it came back as ${n.peer.meshIp}, not ${ipBefore}` };
  return { ok: true };
}
