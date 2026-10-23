import type { DbBackupEngine } from '@swarmy/core/protocol';

/**
 * The restore-point grid on /backups: one lane per thing that is saved
 * (a volume, a database, swarmy itself), one cell per night for the last 14
 * UTC days. A cell holds every attempt that day; the one to restore from is
 * the newest that worked. Pure, so the maths is tested apart from the page.
 */

export const NIGHTS = 14;
const DAY_MS = 86_400_000;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type SaveStatus = 'ok' | 'failed' | 'running';
export type CellState = 'ok' | 'retried' | 'failed' | 'running';
export type LaneKind = 'volume' | 'db' | 'controller';

export interface GridSave {
  id: string;
  atMs: number;
  status: SaveStatus;
  sizeBytes: string | null;
  /** Destination name (and id, where a restore needs it). */
  where: string | null;
  whereId?: string;
  /** Database saves: the engine a restore must use. */
  engine?: DbBackupEngine | null;
  error?: string | null;
}

export interface GridCell {
  state: CellState;
  /** What a restore uses: the newest save that worked, else the newest attempt. */
  save: GridSave;
  attempts: GridSave[];
}

export interface GridLane {
  key: string;
  kind: LaneKind;
  name: string;
  meta: string;
  /** The volume, `stack/cluster` or `controller`: what a restore acts on. */
  ref: string;
  cells: (GridCell | null)[];
}

/** UTC midnights for the last `n` days, oldest first; the last is today. */
export function nightStarts(nowMs: number, n = NIGHTS): number[] {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Array.from({ length: n }, (_, i) => today - (n - 1 - i) * DAY_MS);
}

/** A column's day number ("11"); the last night reads "today". */
export function nightLabel(startMs: number, isToday: boolean): string {
  return isToday ? 'today' : String(new Date(startMs).getUTCDate());
}

/** The months the nights span, for the header: "Oct" or "Sep – Oct". */
export function nightMonths(starts: number[]): string {
  const months = [...new Set(starts.map((s) => MONTH[new Date(s).getUTCMonth()]))];
  return months.length > 1 ? `${months[0]} – ${months[months.length - 1]}` : (months[0] ?? '');
}

function cellOf(attempts: GridSave[]): GridCell {
  const sorted = [...attempts].sort((a, b) => a.atMs - b.atMs);
  const oks = sorted.filter((s) => s.status === 'ok');
  const newest = sorted[sorted.length - 1]!;
  if (oks.length) {
    const save = oks[oks.length - 1]!;
    const failedFirst = sorted.some((s) => s.status === 'failed' && s.atMs < save.atMs);
    return { state: failedFirst ? 'retried' : 'ok', save, attempts: sorted };
  }
  return { state: newest.status === 'running' ? 'running' : 'failed', save: newest, attempts: sorted };
}

/** Bucket one lane's saves into its nights (saves outside the window drop out). */
export function laneCells(saves: GridSave[], starts: number[]): (GridCell | null)[] {
  const first = starts[0] ?? 0;
  const byNight = new Map<number, GridSave[]>();
  for (const s of saves) {
    const i = Math.floor((s.atMs - first) / DAY_MS);
    if (i < 0 || i >= starts.length) continue;
    byNight.set(i, [...(byNight.get(i) ?? []), s]);
  }
  return starts.map((_, i) => {
    const attempts = byNight.get(i);
    return attempts?.length ? cellOf(attempts) : null;
  });
}

/**
 * "8 of 8 saved last night": each lane's newest attempt in the last 26 hours
 * (a nightly run, whichever side of midnight it landed), counted saved when
 * its day worked. Lanes with no attempt in that span aren't counted.
 */
export function lastNight(lanes: GridLane[], nowMs: number): { saved: number; total: number } {
  let saved = 0;
  let total = 0;
  for (const lane of lanes) {
    const recent = lane.cells
      .filter((c): c is GridCell => c != null && nowMs - c.save.atMs < 26 * 3_600_000 && c.state !== 'running')
      .at(-1);
    if (!recent) continue;
    total += 1;
    if (recent.state === 'ok' || recent.state === 'retried') saved += 1;
  }
  return { saved, total };
}

/** The newest cell in a lane, the grid's default pick. */
export function newestCell(lanes: GridLane[]): { lane: number; night: number } | null {
  let best: { lane: number; night: number; atMs: number } | null = null;
  for (let lane = 0; lane < lanes.length; lane++) {
    const cells = lanes[lane]!.cells;
    for (let night = 0; night < cells.length; night++) {
      const c = cells[night];
      if (c && c.state !== 'running' && (best === null || c.save.atMs > best.atMs)) best = { lane, night, atMs: c.save.atMs };
    }
  }
  return best && { lane: best.lane, night: best.night };
}
