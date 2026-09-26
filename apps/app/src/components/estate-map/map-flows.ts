import type { TrafficNowView } from '@swarmy/core';
import type { Box, PlacedBlob } from './map-layout';

/**
 * Visitor flows and their words, pure: which regions have edge traffic
 * (`traffic.now`), where each flow enters the canvas, and the plain phrasing
 * ("EU visitors · 434/min", "434 visitors a minute"). No data is never a zero.
 */

const AREA: Record<string, string> = {
  us: 'US',
  eu: 'EU',
  ca: 'Canada',
  sa: 'South America',
  me: 'Middle East',
  af: 'Africa',
  ap: 'Asia-Pacific',
  au: 'Australia',
};

/** "eu-west" → "EU"; an unknown label stays itself; no label → null. */
export function regionArea(region: string | null): string | null {
  if (!region) return null;
  const head = region.toLowerCase().split(/[-_.]/)[0] ?? '';
  return AREA[head] ?? region;
}

/** "EU-WEST", or "NO REGION YET" for the unlabelled group. */
export function regionLabel(region: string | null): string {
  return region ? region.toUpperCase() : 'No region yet';
}

/** Whole visits a minute ("434"); under ten keeps one decimal. */
export function perMin(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** The flow label on the map: "EU visitors · 434/min". */
export function flowLabel(region: string | null, rate: number): string {
  const area = regionArea(region);
  return `${area ? `${area} visitors` : 'Visitors'} · ${perMin(rate)}/min`;
}

/** The phone line under a region: "434 visitors a minute". */
export function visitorsLine(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return 'No traffic data yet';
  return `${perMin(rate)} visitor${rate === 1 ? '' : 's'} a minute`;
}

export interface RegionTraffic {
  /** Requests a minute at this region's front doors; null = no edge reporting. */
  rate: number | null;
  /** Front-door servers counted in this region. */
  edges: number;
}

/** traffic.now → per region label. Missing view → empty (still loading). */
export function trafficByRegion(now: TrafficNowView | undefined): Map<string | null, RegionTraffic> {
  const out = new Map<string | null, RegionTraffic>();
  for (const r of now?.regions ?? []) {
    out.set(r.region, { rate: r.state === 'reporting' ? r.requestsPerMin : null, edges: r.edges.length });
  }
  return out;
}

export interface Flow {
  region: string | null;
  rate: number;
  /** SVG path from the canvas edge to the blob's label. */
  d: string;
  /** Where the label sits (top-left of the text). */
  label: { x: number; y: number };
  from: 'top' | 'left' | 'right';
}

export interface Canvas {
  width: number;
  /** Boxes flows and their labels stay out of (the floating Right-now card). */
  keepClear?: Box[];
}

/** Room one flow label needs across ("Asia-Pacific visitors · 61/min" at 12px mono, plus the region code at Controls). */
const LABEL_W = 290;

type Pt = [number, number];

/** Points along a quadratic curve, for the does-it-cross-a-blob test. */
function samples(a: Pt, c: Pt, b: Pt, n = 24): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
  });
}

const overlapsBox = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (p: Pt, r: Box, pad = 14): boolean =>
  p[0] > r.x - pad && p[0] < r.x + r.w + pad && p[1] > r.y - pad && p[1] < r.y + r.h + pad;

/**
 * One flow per region with traffic, from the canvas edge into the top of its
 * blob. Western blobs are fed from the left, the rest from the top; the first
 * route that crosses no other blob wins (the top edge if none is clear).
 */
export function flowFor(blob: PlacedBlob, rate: number, canvas: Canvas, others: Box[] = []): Flow {
  const W = canvas.width;
  // Top routes land on the blob's top edge; side routes on the facing side, near the label.
  const topEnd: Pt = [blob.x + Math.round(blob.w * 0.62), blob.y - 10];
  const top = (x0: number) => ({ from: 'top' as const, a: [x0, 0] as Pt, c: [x0, topEnd[1] * 0.6] as Pt, end: topEnd });
  const left = (y0: number) => {
    const end: Pt = [blob.x - 8, blob.y + 28];
    return { from: 'left' as const, a: [0, y0] as Pt, c: [end[0] - 60, y0] as Pt, end };
  };
  const right = (y0: number) => {
    const end: Pt = [blob.x + blob.w + 8, blob.y + 28];
    return { from: 'right' as const, a: [W, y0] as Pt, c: [end[0] + 60, y0] as Pt, end };
  };
  const ys = [blob.y - 60, blob.y - 24, blob.y + 28, blob.y + 70].map((y) => Math.max(40, y));
  const tops = [topEnd[0] + 36, topEnd[0] - 36, blob.x + 24, blob.x + blob.w - 24].map(top);
  const cx = blob.x + blob.w / 2;
  // A side route needs room to be seen: none for a blob hugging that edge.
  const lefts = blob.x > 90 ? ys.map(left) : [];
  const rights = W - blob.x - blob.w > 90 ? ys.map(right) : [];
  const tries =
    cx < W * 0.28
      ? [...lefts, ...tops, ...rights]
      : cx > W * 0.62
        ? [...rights, ...tops, ...lefts]
        : [...tops, ...lefts, ...rights];
  const blocks = [...others.filter((o) => o !== blob), ...(canvas.keepClear ?? [])];
  const labelAt = (t: (typeof tries)[number]): { x: number; y: number } => {
    if (t.from === 'left') return { x: 12, y: Math.max(8, t.a[1] - 28) };
    if (t.from === 'right') return { x: W - LABEL_W - 4, y: Math.max(8, t.a[1] - 28) };
    return { x: Math.max(8, Math.min(t.a[0] + 10, W - LABEL_W)), y: 12 };
  };
  const labelBox = (l: { x: number; y: number }): Box => ({ x: l.x, y: l.y, w: LABEL_W, h: 20 });
  const clear = (t: (typeof tries)[number]): boolean =>
    samples(t.a, t.c, t.end).every((p) => blocks.every((o) => !inside(p, o))) &&
    [...others, ...(canvas.keepClear ?? [])].every((o) => !overlapsBox(labelBox(labelAt(t)), o));
  const pick = tries.find(clear) ?? tries[0]!;
  const label = labelAt(pick);
  const f = (n: number): string => String(Math.round(n));
  return {
    region: blob.region,
    rate,
    from: pick.from,
    d: `M${f(pick.a[0])} ${f(pick.a[1])} Q ${f(pick.c[0])} ${f(pick.c[1])} ${f(pick.end[0])} ${f(pick.end[1])}`,
    label,
  };
}

/** Flows for every placed blob whose region reports traffic, busiest first. */
export function flowsFor(blobs: PlacedBlob[], traffic: Map<string | null, RegionTraffic>, canvas: Canvas): Flow[] {
  const flows = blobs.flatMap((b) => {
    const t = traffic.get(b.region);
    return t && t.rate !== null && t.rate > 0 ? [flowFor(b, t.rate, canvas, blobs)] : [];
  });
  // Top labels that would touch step down a line instead of overprinting.
  const top = flows.filter((f) => f.from === 'top').sort((a, b) => a.label.x - b.label.x);
  top.forEach((f, i) => {
    const prev = top[i - 1];
    if (prev && f.label.x - prev.label.x < LABEL_W) f.label = { ...f.label, y: prev.label.y + 26 };
  });
  return flows.sort((a, b) => b.rate - a.rate);
}
