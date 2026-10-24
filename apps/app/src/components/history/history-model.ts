/**
 * The managed data history grids (`cache.statsHistory`, `queues.depthHistory`,
 * `buckets.sizeHistory`): point `i` covers the slot starting at
 * `from + i * stepSeconds`, and null is a slot nobody measured — a gap,
 * never a zero. PURE — unit-tested in history-model.test.ts.
 */

export type Series = ReadonlyArray<number | null>;

export interface HistoryGrid {
  from: string;
  stepSeconds: number;
}

/** Start (ms) of slot `i`. */
export function slotStart(g: HistoryGrid, i: number): number {
  return Date.parse(g.from) + i * g.stepSeconds * 1000;
}

export function known(values: Series): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

/** The newest reading, or null when there is none. */
export function lastKnown(values: Series): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Sum of the slots that start at or after `sinceMs` (e.g. local midnight),
 * and whether any of them was measured — `measured: false` reads "not
 * measured yet", not 0.
 */
export function sumSince(g: HistoryGrid, values: Series, sinceMs: number): { total: number; measured: boolean } {
  let total = 0;
  let measured = false;
  values.forEach((v, i) => {
    if (v === null || slotStart(g, i) < sinceMs) return;
    total += v;
    measured = true;
  });
  return { total, measured };
}

/** Add series slot by slot; a slot is null only when every input is. */
export function addSeries(list: ReadonlyArray<Series>): Array<number | null> {
  const len = Math.max(0, ...list.map((s) => s.length));
  return Array.from({ length: len }, (_, i) => {
    const vs = list.map((s) => s[i]).filter((v): v is number => v !== null && v !== undefined);
    return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
  });
}

/** Runs of consecutive readings, as [slot, value] pairs (a null ends a run). */
export function runsOf(values: Series): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> | null = null;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      run = null;
      return;
    }
    if (!run) out.push((run = []));
    run.push([i, v]);
  });
  return out;
}

/**
 * An SVG path for `values` on a min..max scale (min 0 unless given). A null
 * lifts the pen (a gap); `step` draws a staircase (copies change in steps,
 * not slopes); `closed` drops every run to the baseline, for an area fill.
 */
export function seriesPath(
  values: Series,
  w: number,
  h: number,
  max: number,
  opts: { step?: boolean; closed?: boolean; min?: number } = {},
): string {
  const min = opts.min ?? 0;
  if (values.length === 0 || !(max > min)) return '';
  const dx = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (v: number): string => (h - 1 - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * (h - 2)).toFixed(1);
  const base = (h - 1).toFixed(1);
  return runsOf(values)
    .map((run) => {
      const pts = run.map(([i, v]) => [(i * dx).toFixed(1), y(v)] as const);
      const [x0, y0] = pts[0]!;
      let d = opts.closed ? `M${x0} ${base} L${x0} ${y0}` : `M${x0} ${y0}`;
      for (const [x, yy] of pts.slice(1)) d += opts.step ? ` H${x} V${yy}` : ` L${x} ${yy}`;
      if (opts.closed) d += ` L${pts[pts.length - 1]![0]} ${base} Z`;
      return d;
    })
    .join(' ');
}

/** A short clock time for slot tooltips: "14:05". */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
