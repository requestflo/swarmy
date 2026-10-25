import { diskFit, freeDiskBytes, type DiskFit, type NodeVolumeSizes } from '@swarmy/core';
import type { FleetView } from '../fleet/fleet-model';
import type { FleetServer } from '../use-fleet';
import { fitCheck, type Fit, type MemoryNow } from './fit-check';
import { targetBlock } from './move-rules';

/**
 * Every other server as a place the service could go, pure: whether it can
 * take it at all, how its memory would fit, and whether its data fits on the
 * disk. The disk check is `@swarmy/core` `diskFit` — the mover's own rule —
 * over the SOURCE server's reported volume sizes (`nodes.volumeSizes`) and
 * each target's free disk from its live sample.
 */

export interface TargetPlan {
  id: string;
  name: string;
  block: string | null;
  fit: Fit;
  /** Disk fit for the data that moves; null while its volumes are still being read. */
  disk: DiskFit | null;
}

/** A server's memory now: the live sample, else the summary's percent of its size. */
export function memoryNow(s: FleetServer): MemoryNow | null {
  if (s.live?.memTotalBytes) return { usedBytes: s.live.memUsedBytes, totalBytes: s.live.memTotalBytes };
  const total = s.node.resources.memBytes;
  if (!total || !s.node.live) return null;
  return { usedBytes: (s.node.live.memPercent / 100) * total, totalBytes: total };
}

/** Volume name → bytes as `nodeId` reported them; null when it reports none (older agent, still loading). */
export function sizesOn(reports: readonly NodeVolumeSizes[] | undefined, nodeId: string): Map<string, number> | null {
  const r = reports?.find((x) => x.nodeId === nodeId);
  return r && r.sampledAt !== null ? new Map(r.volumes.map((v) => [v.name, v.sizeBytes])) : null;
}

export function planTargets(o: {
  fromId: string;
  servers: FleetView[];
  needBytes: number | null;
  volumes: string[] | undefined;
  sizes: readonly NodeVolumeSizes[] | undefined;
}): TargetPlan[] {
  const from = o.servers.find((s) => s.server.node.id === o.fromId);
  const source = from ? memoryNow(from.server) : null;
  const sizes = sizesOn(o.sizes, o.fromId);
  return o.servers
    .filter((s) => s.server.node.id !== o.fromId)
    .map((s): TargetPlan => {
      const n = s.server.node;
      return {
        id: n.id,
        name: n.name,
        block: targetBlock(o.fromId, n),
        fit: fitCheck({ needBytes: o.needBytes, dest: memoryNow(s.server), source }),
        disk: o.volumes ? diskFit({ volumes: o.volumes, sizes, freeBytes: freeDiskBytes(s.server.live) }) : null,
      };
    });
}

/** Can it go there as far as the numbers say (not blocked, and the data fits on the disk)? */
export const roomFor = (t: TargetPlan): boolean => !t.block && t.disk?.verdict !== 'wont-fit';
