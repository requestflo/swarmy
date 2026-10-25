/**
 * Will a service fit on another server? Pure, so it is tested once. The
 * check is memory only, from numbers swarmy already has: the service's
 * busiest copy right now (`services.usage`, peak) times the copies being
 * moved, against the destination's live memory (`nodes.liveStatsLatest`).
 * Disk room is the mover's own rule, `@swarmy/core` `diskFit`, applied in
 * `move-targets.ts` — never a copy of it here.
 */

/** Memory use (after the move) from which a server is "nearly full". */
export const TIGHT_PCT = 80;
/** Memory use (after the move) from which it won't fit. */
export const WONT_FIT_PCT = 90;

export type FitVerdict = 'fits' | 'tight' | 'wont-fit' | 'unknown';

export interface MemoryNow {
  usedBytes: number;
  totalBytes: number;
}

export interface Fit {
  verdict: FitVerdict;
  /** Memory the moved copies use (null = no reading yet). */
  needBytes: number | null;
  /** Destination memory use before and after, 0..100+ (null without live numbers). */
  beforePct: number | null;
  afterPct: number | null;
  freeBytes: number | null;
  /** The server it leaves: memory use before and after. */
  source: { beforePct: number; afterPct: number } | null;
}

const pct = (used: number, total: number): number => Math.round((used / total) * 100);

/** The fit of `needBytes` on `dest`, and what it frees on `source`. */
export function fitCheck(input: { needBytes: number | null; dest: MemoryNow | null; source?: MemoryNow | null }): Fit {
  const { needBytes, dest } = input;
  const src = input.source && input.source.totalBytes > 0 ? input.source : null;
  const source =
    src && needBytes !== null
      ? { beforePct: pct(src.usedBytes, src.totalBytes), afterPct: pct(Math.max(0, src.usedBytes - needBytes), src.totalBytes) }
      : null;
  if (!dest || dest.totalBytes <= 0) {
    return { verdict: 'unknown', needBytes, beforePct: null, afterPct: null, freeBytes: null, source };
  }
  const beforePct = pct(dest.usedBytes, dest.totalBytes);
  const freeBytes = Math.max(0, dest.totalBytes - dest.usedBytes);
  if (needBytes === null) return { verdict: 'unknown', needBytes, beforePct, afterPct: null, freeBytes, source };
  const afterPct = pct(dest.usedBytes + needBytes, dest.totalBytes);
  const verdict: FitVerdict =
    needBytes > freeBytes || afterPct > WONT_FIT_PCT ? 'wont-fit' : afterPct > TIGHT_PCT ? 'tight' : 'fits';
  return { verdict, needBytes, beforePct, afterPct, freeBytes, source };
}

/** Memory the move takes along: the busiest copy now × the copies that move. */
export function needFromUsage(usage: { memBytes: { peak: number } } | null | undefined, copies: number): number | null {
  if (!usage) return null;
  return usage.memBytes.peak * Math.max(1, copies);
}

/** The roomiest server that still fits (lowest memory use after), for "try X instead". */
export function roomiest<T extends { fit: Fit }>(candidates: T[]): T | null {
  const ok = candidates.filter((c) => c.fit.verdict === 'fits' && c.fit.afterPct !== null);
  return ok.sort((a, b) => a.fit.afterPct! - b.fit.afterPct!)[0] ?? null;
}

/** "Fits" · "Tight fit" · "Won't fit" · "Can't check memory": the verdict as a word. */
export const FIT_WORD: Record<FitVerdict, string> = {
  fits: 'Fits',
  tight: 'Tight fit',
  'wont-fit': 'Won’t fit',
  unknown: 'Can’t check memory',
};
