/**
 * Will a service's data fit on another server's disk? (board 9, "disk
 * fit"). Pure, and the ONE rule: the mover refuses with it
 * (`planServiceMove`) and the Move dialog previews with it — the dashboard
 * never keeps its own copy.
 *
 * The data is the total size of the volumes that move, as the SOURCE
 * server's agent measured them (`metrics.volumes`); the room is the target's
 * free disk where Docker keeps volumes (`metrics.node.fs*`). The target
 * must have `size × DISK_FIT_HEADROOM` free. A size or a free figure nobody
 * reported is unknown — a warning, never a refusal and never a zero — except
 * when what IS known already doesn't fit.
 */

/** Free disk the target needs per byte that moves (20% to spare). */
export const DISK_FIT_HEADROOM = 1.2;

export type DiskFitVerdict = 'fits' | 'wont-fit' | 'unknown';

export interface DiskFit {
  verdict: DiskFitVerdict;
  /** Total size of the volumes that move; null when any of them is unreported. */
  needBytes: number | null;
  /** The part of it that is known (every reported volume). */
  knownBytes: number;
  /** Free disk the target must have (`knownBytes × headroom`). */
  requiredBytes: number;
  /** The target's free disk; null when it isn't reporting. */
  freeBytes: number | null;
  /** Volumes whose size the source server hasn't reported. */
  unreported: string[];
}

export function diskFit(input: {
  volumes: readonly string[];
  /** Volume name → bytes on the source server; null = that server reports no sizes. */
  sizes: ReadonlyMap<string, number> | null;
  freeBytes: number | null;
  headroom?: number;
}): DiskFit {
  const headroom = input.headroom ?? DISK_FIT_HEADROOM;
  const volumes = [...new Set(input.volumes)];
  const unreported = volumes.filter((v) => !input.sizes?.has(v));
  const knownBytes = volumes.reduce((n, v) => n + (input.sizes?.get(v) ?? 0), 0);
  const requiredBytes = Math.ceil(knownBytes * headroom);
  const freeBytes = input.freeBytes !== null && Number.isFinite(input.freeBytes) ? Math.max(0, input.freeBytes) : null;
  const needBytes = unreported.length === 0 ? knownBytes : null;
  const verdict: DiskFitVerdict =
    freeBytes !== null && requiredBytes > freeBytes ? 'wont-fit' : freeBytes === null || unreported.length > 0 ? 'unknown' : 'fits';
  return { verdict, needBytes, knownBytes, requiredBytes, freeBytes, unreported };
}

/** Free bytes from a node stats sample (`fsTotalBytes − fsUsedBytes`); null without both. */
export function freeDiskBytes(stats: { fsTotalBytes: number | null; fsUsedBytes: number | null } | null | undefined): number | null {
  if (!stats || stats.fsTotalBytes == null || stats.fsUsedBytes == null || !(stats.fsTotalBytes > 0)) return null;
  return Math.max(0, stats.fsTotalBytes - stats.fsUsedBytes);
}

/** "4.2 GB" · "31 GB" · "640 MB": the size words the Move dialog and the refusals use. */
export function diskSizeWord(bytes: number): string {
  if (!(bytes > 0)) return '0 MB';
  const g = bytes / 1024 ** 3;
  if (g < 1) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${g >= 10 ? g.toFixed(0) : g.toFixed(1)} GB`;
}

/** The Move dialog's line: "needs 4.2 GB · target has 31 GB free". */
export function diskFitLine(fit: DiskFit): string {
  const need =
    fit.needBytes !== null
      ? `needs ${diskSizeWord(fit.needBytes)}`
      : fit.knownBytes > 0
        ? `needs at least ${diskSizeWord(fit.knownBytes)} (size not reported for ${fit.unreported.join(', ')})`
        : 'size not reported';
  const room = fit.freeBytes !== null ? `target has ${diskSizeWord(fit.freeBytes)} free` : 'target’s free disk not reported';
  return `${need} · ${room}`;
}

/** Why a move is refused for disk, in plain words (verdict `wont-fit`). */
export function diskFitRefusal(service: string, target: string, fit: DiskFit): string {
  const size = `${fit.needBytes === null ? 'at least ' : ''}${diskSizeWord(fit.knownBytes)}`;
  return `${service}’s data is ${size} and ${target} has ${diskSizeWord(fit.freeBytes ?? 0)} free — swarmy wants ${diskSizeWord(fit.requiredBytes)} free so the disk doesn’t fill up. Free some space on ${target}, or pick another server.`;
}

/** The warning a move carries when the fit can't be checked (verdict `unknown`); null otherwise. */
export function diskFitWarning(service: string, target: string, fit: DiskFit): string | null {
  if (fit.verdict !== 'unknown') return null;
  if (fit.unreported.length > 0) {
    return `swarmy doesn’t know how big ${service}’s data is (size not reported for ${fit.unreported.join(', ')}), so it can’t check it fits on ${target}.`;
  }
  return `${target} isn’t reporting its free disk, so swarmy can’t check ${service}’s data fits.`;
}
