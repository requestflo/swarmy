/**
 * The mover's disk-fit read (board 9): the service's volumes as the SOURCE
 * server's agent sized them (`metrics.volumes`, hub memory) against the
 * target's free disk (its live stats). The rule itself is `@swarmy/core`
 * `diskFit` — the same one the Move dialog previews with.
 */
import { diskFit, freeDiskBytes, type DiskFit } from '@swarmy/core';
import type { OrgContext } from '../context';

export function moveDiskFit(ctx: Pick<OrgContext, 'hub'>, input: { volumes: readonly string[]; fromNodeId: string; toNodeId: string }): DiskFit {
  const report = ctx.hub.volumeSizesFor?.(input.fromNodeId);
  const sizes = report ? new Map(report.volumes.map((v) => [v.name, v.sizeBytes])) : null;
  // Optional call: test hubs may not carry live stats; no sample is "not reported".
  const free = freeDiskBytes(ctx.hub.latestNodeStats?.(input.toNodeId));
  return diskFit({ volumes: input.volumes, sizes, freeBytes: free });
}
