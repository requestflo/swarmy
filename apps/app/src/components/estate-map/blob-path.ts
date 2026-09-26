/**
 * A soft region blob around a box: a rounded superellipse with a gentle,
 * deterministic wobble (seeded by the region label, so it never jumps), drawn
 * as a closed Catmull-Rom curve. Only ever bulges outward, so it always holds
 * the cards inside the box.
 */

function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const POINTS = 28;
const EXP = 6;
const GROW = 16;

export function blobPath(box: { x: number; y: number; w: number; h: number }, key: string): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const a = box.w / 2 + GROW;
  const b = box.h / 2 + GROW;
  const seed = seedOf(key);
  const [ph1, ph2] = [(seed % 628) / 100, ((seed >>> 10) % 628) / 100];
  const pts: [number, number][] = [];
  for (let i = 0; i < POINTS; i++) {
    const t = (2 * Math.PI * i) / POINTS;
    const c = Math.cos(t);
    const s = Math.sin(t);
    // A slow, smooth wobble that only ever grows the shape (1.00 … 1.06).
    const k = 1 + 0.02 * (1 + Math.sin(2 * t + ph1)) + 0.01 * (1 + Math.sin(3 * t + ph2));
    pts.push([cx + k * a * Math.sign(c) * Math.abs(c) ** (2 / EXP), cy + k * b * Math.sign(s) * Math.abs(s) ** (2 / EXP)]);
  }
  const at = (i: number): [number, number] => pts[(i + POINTS) % POINTS]!;
  const f = (n: number): string => n.toFixed(1);
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < POINTS; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0]!)} ${f(c1[1]!)} ${f(c2[0]!)} ${f(c2[1]!)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}
