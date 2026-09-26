import { buildInventory } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';

/**
 * A stack's DATA on delete ("Also delete this app's data", unchecked by
 * default). Its named volumes are node-local, so they live on whichever
 * servers ran its tasks; its owned secret families (the blueprint's generated
 * passwords) belong with that data — a database volume was initialised with
 * them. Kept together, a same-name redeploy adopts the family and the old data
 * still opens; deleted together, the next deploy starts clean.
 */

const CONTAINER_DRAIN_TIMEOUT_MS = 30_000;
const CONTAINER_DRAIN_POLL_MS = 1_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * PURE — the named volumes a stack uses: every `volume` mount of its live
 * services (Docker truth, incl. managed-data members) plus those its compose
 * declares (a service that never ran, or an older agent reporting no mounts).
 */
export function stackVolumeNames(
  liveMounts: ReadonlyArray<ReadonlyArray<{ type?: string; source?: string }> | undefined>,
  composeSpecs: readonly Pick<ServiceSpec, 'mounts'>[],
): string[] {
  const out = new Set<string>();
  for (const mounts of liveMounts) {
    for (const m of mounts ?? []) if ((m.type ?? 'volume') === 'volume' && m.source) out.add(m.source);
  }
  for (const s of composeSpecs) {
    for (const m of s.mounts ?? []) if (m.type === 'volume' && m.source) out.add(m.source);
  }
  return [...out].sort();
}

/** The live mounts of a stack's services, read BEFORE they are removed. */
export function liveStackMounts(ctx: OrgContext, stack: string): Array<Array<{ type?: string; source?: string }> | undefined> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const names = new Set(buildInventory(services, containers).services.filter((s) => s.stack === stack).map((s) => s.name));
  return services.filter((s) => names.has(s.name)).map((s) => s.mounts);
}

/** Wait (bounded) until none of the stack's containers is still running — a mounted volume can't be removed. */
async function drainContainers(ctx: OrgContext, stack: string): Promise<void> {
  const deadline = Date.now() + CONTAINER_DRAIN_TIMEOUT_MS;
  for (;;) {
    const { containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    const left = containers.some((c) => c.labels?.['com.docker.stack.namespace'] === stack);
    if (!left || Date.now() >= deadline) return;
    await sleep(CONTAINER_DRAIN_POLL_MS);
  }
}

/**
 * Remove the stack's named volumes on every online server, then check each
 * server's `volume.list`: a volume still there is reported, never claimed
 * deleted. Returns what went and what stayed.
 */
export async function removeStackVolumes(
  ctx: OrgContext,
  stack: string,
  volumes: readonly string[],
): Promise<{ deleted: string[]; failed: string[] }> {
  if (!volumes.length) return { deleted: [], failed: [] };
  await drainContainers(ctx, stack);
  const nodes = ctx.hub.onlineNodeIds();
  const wanted = new Set(volumes);
  const stillThere = new Set<string>();
  for (const nodeId of nodes) {
    for (const name of volumes) {
      await ctx.hub.dispatch(nodeId, 'volume.remove', { name, cluster: false }).catch(() => undefined); // absent here = fine
    }
    const listed = await ctx.hub
      .dispatch<{ volumes?: Array<{ name: string }> }>(nodeId, 'volume.list', { cluster: false })
      .catch(() => null);
    for (const v of listed?.volumes ?? []) if (wanted.has(v.name)) stillThere.add(v.name);
  }
  return { deleted: volumes.filter((v) => !stillThere.has(v)), failed: [...stillThere].sort() };
}
