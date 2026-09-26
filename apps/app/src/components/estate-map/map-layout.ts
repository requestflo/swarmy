/**
 * The estate map's geometry, pure so it is tested once: servers grouped into
 * one blob per region label, each blob sized to hold its server cards at
 * their real size (text is never scaled down), placed by rough geography
 * (the region's coordinates from `geodns.listRegions`) and then pushed apart
 * until nothing overlaps. Regions without coordinates, and the servers with
 * no region label, take the next free spot in an even row underneath.
 */

export const CARD_W = 236;
export const CARD_GAP = 12;
export const BLOB_PAD = 18;
/** The mono region label above the cards. */
export const BLOB_LABEL = 30;
/** Room above the blobs for the visitor-flow labels. */
export const TOP = 84;
export const SIDE = 20;
/** Space between blob boxes: room for both soft outlines (they grow ~20px) and a gap. */
const MARGIN = 52;
const BOTTOM = 28;

/** Padding, header (ring + name + roles), the lens line and the borders (server-card.tsx). */
const CARD_BASE = 92;
/** One extra 20px mono line and its gap (a reachability note, the Controls tech line). */
const CARD_NOTE = 26;
/** An app row (and its gap); 44px targets on touch screens. */
export const APP_ROW = 34;
export const APP_ROW_COARSE = 48;

/** A server's card height from what it shows: the header, the lens line, its notes and one row per app. */
export function cardHeight(c: { apps: number; notes: number; coarse?: boolean }): number {
  return CARD_BASE + CARD_NOTE * c.notes + Math.max(1, c.apps) * (c.coarse ? APP_ROW_COARSE : APP_ROW);
}

export interface GroupInput {
  /** The `swarmy.region` label; null = servers with no region yet. */
  region: string | null;
  lat: number | null;
  lon: number | null;
  /** Card heights, in the order the servers are drawn. */
  cards: { id: string; h: number }[];
}

export interface PlacedCard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedBlob {
  region: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  cards: PlacedCard[];
}

export interface MapLayout {
  width: number;
  height: number;
  blobs: PlacedBlob[];
}

/** Servers bucketed by region label, labelled regions first (alphabetical), "no region" last. */
export function groupByRegion<T extends { region?: string | null }>(servers: T[]): { region: string | null; servers: T[] }[] {
  const by = new Map<string | null, T[]>();
  for (const s of servers) {
    const k = s.region?.trim() || null;
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([region, list]) => ({ region, servers: list }));
}

/** Cards two to a row; the blob wraps them with padding and the label on top. */
function sizeBlob(g: GroupInput): { w: number; h: number; cards: PlacedCard[] } {
  const cols = Math.min(2, Math.max(1, g.cards.length));
  const cards: PlacedCard[] = [];
  let y = BLOB_LABEL + BLOB_PAD * 0.5;
  for (let i = 0; i < g.cards.length; i += cols) {
    const row = g.cards.slice(i, i + cols);
    const rowH = Math.max(...row.map((c) => c.h));
    row.forEach((c, k) => cards.push({ id: c.id, x: BLOB_PAD + k * (CARD_W + CARD_GAP), y, w: CARD_W, h: c.h }));
    y += rowH + CARD_GAP;
  }
  const w = cols * CARD_W + (cols - 1) * CARD_GAP + 2 * BLOB_PAD;
  const h = Math.max(y - CARD_GAP + BLOB_PAD, BLOB_LABEL + 2 * BLOB_PAD);
  return { w, h, cards };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box, m = MARGIN): boolean =>
  a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/**
 * Lay the blobs out in a `width`-wide canvas, around any `keepClear` boxes
 * (the floating Right-now card). Deterministic: the same input always gives
 * the same picture, so the map doesn't jump between polls.
 */
export function layoutMap(groups: GroupInput[], width: number, keepClear: Box[] = []): MapLayout {
  const sized = groups.map((g) => ({ g, ...sizeBlob(g) }));
  const geo = sized.filter((s) => s.g.lat !== null && s.g.lon !== null);
  const rest = sized.filter((s) => s.g.lat === null || s.g.lon === null);
  const lons = geo.map((s) => s.g.lon!);
  const lats = geo.map((s) => s.g.lat!);
  const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  const yRange = Math.max(160, geo.length * 70);

  const boxes: (Box & { s: (typeof sized)[number] })[] = geo.map((s) => {
    const fx = maxLon > minLon ? (s.g.lon! - minLon) / (maxLon - minLon) : 0.5;
    const fy = maxLat > minLat ? (maxLat - s.g.lat!) / (maxLat - minLat) : 0;
    return { s, w: s.w, h: s.h, x: SIDE + fx * Math.max(0, width - s.w - 2 * SIDE), y: TOP + fy * yRange };
  });

  // Spread: push overlapping pairs apart along their shallower axis, a few rounds.
  const clamp = (b: Box): void => {
    b.x = Math.min(Math.max(SIDE, b.x), Math.max(SIDE, width - b.w - SIDE));
    b.y = Math.max(TOP, b.y);
  };
  for (let round = 0; round < 60; round++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (!overlaps(a, b)) continue;
        moved = true;
        const dx = Math.min(a.x + a.w + MARGIN - b.x, b.x + b.w + MARGIN - a.x);
        const dy = Math.min(a.y + a.h + MARGIN - b.y, b.y + b.h + MARGIN - a.y);
        if (dx <= dy) {
          const dir = a.x + a.w / 2 <= b.x + b.w / 2 ? 1 : -1;
          a.x -= (dir * dx) / 2;
          b.x += (dir * dx) / 2;
        } else {
          const dir = a.y + a.h / 2 <= b.y + b.h / 2 ? 1 : -1;
          a.y -= (dir * dy) / 2;
          b.y += (dir * dy) / 2;
        }
        clamp(a);
        clamp(b);
      }
      const a = boxes[i]!;
      for (const o of keepClear) {
        if (!overlaps(a, o)) continue;
        moved = true;
        const dx = a.x + a.w / 2 <= o.x + o.w / 2 ? o.x - MARGIN - a.w - a.x : o.x + o.w + MARGIN - a.x;
        const dy = o.y + o.h + MARGIN - a.y;
        if (Math.abs(dx) <= dy) a.x += dx;
        else a.y += dy;
        clamp(a);
      }
    }
    if (!moved) break;
  }

  // Settle: anything still touching (a canvas too narrow to spread sideways) drops below.
  const placed: typeof boxes = [];
  const settle = (b: Box): void => {
    let hit: Box | undefined = [...keepClear, ...placed].find((p) => overlaps(p, b));
    while (hit) {
      b.y = hit.y + hit.h + MARGIN;
      hit = [...keepClear, ...placed].find((p) => overlaps(p, b));
    }
  };
  for (const b of [...boxes].sort((p, q) => p.y - q.y || p.x - q.x)) {
    settle(b);
    placed.push(b);
  }

  // No coordinates: an even row under the geography.
  let rowY = placed.length ? Math.max(...placed.map((p) => p.y + p.h)) + MARGIN : TOP;
  let x = SIDE;
  let rowH = 0;
  for (const s of rest) {
    if (x > SIDE && x + s.w > width - SIDE) {
      rowY += rowH + MARGIN;
      x = SIDE;
      rowH = 0;
    }
    const b = { s, w: s.w, h: s.h, x, y: rowY };
    settle(b);
    placed.push(b);
    x += s.w + MARGIN;
    rowH = Math.max(rowH, s.h);
  }

  const blobs: PlacedBlob[] = placed.map((b) => ({
    region: b.s.g.region,
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: b.w,
    h: b.h,
    cards: b.s.cards.map((c) => ({ ...c, x: Math.round(b.x + c.x), y: Math.round(b.y + c.y) })),
  }));
  const height = Math.max(TOP, ...blobs.map((b) => b.y + b.h), ...keepClear.map((o) => o.y + o.h)) + BOTTOM;
  const right = blobs.length ? Math.max(...blobs.map((b) => b.x + b.w)) + SIDE : width;
  return { width: Math.max(width, right), height, blobs };
}
