import type { DbBackupEngine } from '@swarmy/core/protocol';
import { isPhysical } from '@/components/stacks/db-backup-format';

/**
 * Retention you can see: where each restore point sits in the keep window
 * and which ones a new window would remove.
 *
 * How swarmy prunes (agent `forgetArgsFor`): after each successful LOGICAL
 * save it runs `restic forget --keep-within <N>d --prune`, scoped to that
 * save's tags (this cluster + its engine). restic measures the window back
 * from the newest snapshot, which after the next run is the next save. So a
 * point goes when it is older than (next run − N days) AND it has the
 * schedule's engine. Physical engines (wal-g / pgBackRest) never go through
 * restic: nothing in the bucket is pruned, N only bounds the restore window.
 */

export const RETENTION_CHOICES = [7, 14, 30, 90] as const;

const DAY_MS = 86_400_000;

export interface CatalogPoint {
  id: string;
  time: string;
  engine: DbBackupEngine | null;
  sizeBytes: string | null;
}

export interface PreviewPoint extends CatalogPoint {
  timeMs: number;
  /** 0 = left edge (oldest), 1 = now. */
  frac: number;
  keep: boolean;
}

export interface RetentionPreview {
  points: PreviewPoint[];
  kept: number;
  pruned: number;
  /** Share of the strip (from the right) the keep window covers. */
  keepFrac: number;
  fromMs: number;
  toMs: number;
}

/** The four standard windows, plus the current one when it is something else. */
export function retentionChoices(current: number | null): number[] {
  const all = new Set<number>(RETENTION_CHOICES);
  if (current != null && current >= 1) all.add(current);
  return [...all].sort((a, b) => a - b);
}

export function retentionPreview(
  catalog: CatalogPoint[],
  days: number,
  opts: { nowMs: number; nextRunMs?: number | null; engine: DbBackupEngine | null },
): RetentionPreview {
  const base = Math.max(opts.nowMs, opts.nextRunMs ?? opts.nowMs);
  const cutoff = base - days * DAY_MS;
  const prunes = opts.engine != null && !isPhysical(opts.engine);
  const timed = catalog
    .map((p) => ({ ...p, timeMs: Date.parse(p.time) }))
    .filter((p) => Number.isFinite(p.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  const toMs = opts.nowMs;
  // The strip spans the oldest point or the window, whichever reaches further back.
  const fromMs = Math.min(timed[0]?.timeMs ?? cutoff, cutoff, toMs - DAY_MS);
  const width = Math.max(1, toMs - fromMs);
  const points = timed.map((p) => ({
    ...p,
    frac: Math.min(1, Math.max(0, (p.timeMs - fromMs) / width)),
    keep: !prunes || p.engine !== opts.engine || p.timeMs >= cutoff,
  }));
  const pruned = points.filter((p) => !p.keep).length;
  return {
    points,
    kept: points.length - pruned,
    pruned,
    keepFrac: Math.min(1, Math.max(0, (toMs - cutoff) / width)),
    fromMs,
    toMs,
  };
}
