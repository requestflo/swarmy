/**
 * The maths under a bucket's growth forecast. PURE — linear-fit.test.ts.
 */

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Share of the movement the line explains (1 = every reading on it). */
  r2: number;
  n: number;
}

/** Least squares y = intercept + slope·x. Null under two points or with every x the same. */
export function linearFit(pts: ReadonlyArray<{ x: number; y: number }>): LinearFit | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy), n };
}

const MB = 1024 * 1024;
const ROUND = [1, 2, 5, 10, 20, 50, 100, 200, 500];

/** The first round size (1·2·5 steps, MB upwards) at least a quarter above `bytes`. */
export function nextMilestone(bytes: number): number {
  const floor = Math.max(bytes * 1.25, MB);
  for (let unit = MB; unit < Number.MAX_SAFE_INTEGER; unit *= 1024) {
    for (const m of ROUND) if (m * unit >= floor) return m * unit;
  }
  return floor;
}
