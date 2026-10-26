/**
 * Words on curved links (the mesh map's latency, the estate map's), pure:
 * each label tries a few points along its curve and takes the first whose
 * box clears every card and every label already placed. A label that finds
 * no room is left off the canvas (the same words are in the list beside it)
 * rather than printed over a server.
 */

export type Pt = { x: number; y: number };
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A quadratic curve: from `a`, bowed toward `c`, to `b` (SVG `M a Q c b`). */
export interface Quad {
  a: Pt;
  c: Pt;
  b: Pt;
}

export interface LabelAsk {
  id: string;
  text: string;
  curve: Quad;
}

export interface PlacedLabel extends Box {
  id: string;
  text: string;
}

/** Where along the curve to try, middle first. */
const TRIES = [0.5, 0.38, 0.62, 0.28, 0.72];

export function pointOn(q: Quad, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * q.a.x + 2 * u * t * q.c.x + t * t * q.b.x, y: u * u * q.a.y + 2 * u * t * q.c.y + t * t * q.b.y };
}

/** A gentle upward bow so a link across a row never runs through the servers between. */
export function bow(a: Pt, b: Pt, max = 60): Quad {
  return { a, b, c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - Math.min(max, Math.abs(b.x - a.x) / 6) } };
}

export const quadPath = (q: Quad): string => `M${q.a.x} ${q.a.y} Q ${q.c.x} ${q.c.y} ${q.b.x} ${q.b.y}`;

const overlaps = (p: Box, q: Box): boolean => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

/**
 * Place each label (in order) at the first clear point on its curve.
 * `charW` is the mono advance at the label's size; boxes are centred on the
 * point and kept inside `width`.
 */
export function placeLabels(
  asks: readonly LabelAsk[],
  blockers: readonly Box[],
  o: { charW: number; h: number; width: number; pad?: number },
): PlacedLabel[] {
  const pad = o.pad ?? 5;
  const placed: PlacedLabel[] = [];
  for (const ask of asks) {
    const w = Math.ceil(ask.text.length * o.charW + pad * 2);
    for (const t of TRIES) {
      const p = pointOn(ask.curve, t);
      const box = { x: Math.round(p.x - w / 2), y: Math.round(p.y - o.h / 2), w, h: o.h };
      if (box.x < 0 || box.x + w > o.width || box.y < 0) continue;
      if (blockers.some((b) => overlaps(box, b)) || placed.some((b) => overlaps(box, b))) continue;
      placed.push({ id: ask.id, text: ask.text, ...box });
      break;
    }
  }
  return placed;
}
