/**
 * Disk fit for the server-retirement planner. A data step's destination is
 * judged by `@swarmy/core` `diskFit`, the rule `planServiceMove` refuses a
 * move with, so the plan never picks a server the mover then turns away.
 * Sizes are the retiring server's reported volume sizes (`metrics.volumes`,
 * else the planner's own probe); the room is the destination's free disk less
 * what earlier steps of the same plan already promised it.
 *
 * Pure. Tested through `node-decommission.plan.test.ts`.
 */
import { diskFit, diskFitWarning, diskSizeWord, type DiskFit, type DiskFitVerdict } from '@swarmy/core';
import type { DecomNodeInput } from './node-decommission.plan';

/** Fits first, then unknown (a warning); won't-fit is never picked. */
export const FIT_RANK: Record<DiskFitVerdict, number> = { fits: 0, unknown: 1, 'wont-fit': 2 };

export interface FitCandidate {
  node: DecomNodeInput;
  /** Undefined when the step names no volume (nothing to size). */
  fit?: DiskFit;
  /** Past the planner's pressure line after the copy (DESTINATION_MAX_USED_PCT). */
  overPressureLine: boolean;
}

/** The destination's free disk once `reserved` bytes of earlier moves land; null = not reported. */
export function freeAfter(n: DecomNodeInput, reserved: number): number | null {
  if (!n.disk || !(n.disk.totalBytes > 0)) return null;
  return Math.max(0, n.disk.totalBytes - n.disk.usedBytes - reserved);
}

/** diskFit of `volumes` onto `n`; `sizes` maps each volume to bytes as the retiring server measured it. */
export function fitOnto(
  n: DecomNodeInput,
  volumes: readonly string[],
  sizes: ReadonlyMap<string, number>,
  reserved: number,
): DiskFit | undefined {
  if (volumes.length === 0) return undefined;
  return diskFit({ volumes, sizes, freeBytes: freeAfter(n, reserved) });
}

/** The warning a pick carries when its fit couldn't be checked (sizes or free disk not reported). */
export function fitWarning(subject: string, chosen: FitCandidate): string | null {
  return chosen.fit ? diskFitWarning(subject, chosen.node.hostname, chosen.fit) : null;
}

/**
 * Why no server can take `subject`, in plain words. `candidates` are the
 * working servers judged (none was eligible). Null when there were none.
 */
export function noRoomMessage(subject: string, candidates: readonly FitCandidate[], pressurePct: number): string | null {
  if (candidates.length === 0) return null;
  const wont = candidates.filter((c) => c.fit?.verdict === 'wont-fit');
  if (wont.length === candidates.length) {
    const fit = wont[0]!.fit!;
    const size = `${fit.needBytes === null ? 'at least ' : ''}${diskSizeWord(fit.knownBytes)}`;
    const roomiest = [...wont].sort((a, b) => (b.fit!.freeBytes ?? 0) - (a.fit!.freeBytes ?? 0))[0]!;
    return (
      `${subject}'s data is ${size} and no other server has room for it: swarmy wants ${diskSizeWord(fit.requiredBytes)} free, ` +
      `and the most any has is ${diskSizeWord(roomiest.fit!.freeBytes ?? 0)} (${roomiest.node.hostname}).`
    );
  }
  const known = candidates.find((c) => c.fit)?.fit;
  const size = known && known.knownBytes > 0 ? ` (${diskSizeWord(known.knownBytes)})` : '';
  return `No other server has room for ${subject}${size} and stays under ${pressurePct}% full.`;
}
