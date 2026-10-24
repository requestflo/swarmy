/**
 * Split integer `n` by `weights` (largest remainder): shares sum to exactly
 * `n`, so spreading a delta over minutes never gains or loses a request.
 */
export function apportion(n: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (n === 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (n * w) / total);
  const out = exact.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || b.i - a.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left--;
  }
  return out;
}
