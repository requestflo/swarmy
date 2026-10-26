import { z } from 'zod';

/**
 * Rollback timing — how long a put-back took, start to healthy ("Last
 * rollback took 41 s"). The controller records both instants on the
 * rollback's own release row; this is the wire shape and the pure sums.
 */

/** One measured rollback. */
export interface RollbackTimingView {
  /** The rollback's own release (the put-back deploy). */
  releaseId: string;
  stackName: string;
  /** The release whose version went back out. */
  rollbackOf: string;
  startedAt: string;
  healthyAt: string;
  /** Whole seconds from start to every part healthy. */
  tookSec: number;
}

/** The latest measured rollback, of one app or of the whole estate. */
export const LastRollbackInput = z.object({ stackName: z.string().min(1).optional() }).default({});
export type LastRollbackInput = z.infer<typeof LastRollbackInput>;

/** Whole seconds between start and healthy (at least 1: it did take time). */
export function rollbackTookSec(startedAt: Date, healthyAt: Date): number {
  return Math.max(1, Math.round((healthyAt.getTime() - startedAt.getTime()) / 1000));
}

/** "41 s", "2 min 5 s", "12 min" — how the phone says a rollback's length. */
export function rollbackSpanWords(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return min >= 10 || rest === 0 ? `${Math.round(sec / 60)} min` : `${min} min ${rest} s`;
}
