/**
 * Does this Bun push a slow HTTP client's backpressure back into a streamed
 * response body? Measured with a 20 MB/s client reading a 100 MiB stream:
 * Bun 1.3.14 pulled all 100 MiB in the first second (RSS ~450 MiB), so the
 * download sits in controller memory while the browser catches up; Bun 1.4.4
 * pulled at the client's speed (RSS 15 MiB), so the credit window holds all
 * the way to the browser. 1.4.0 as the line is an assumption between the two.
 * Pure.
 */
export function runtimeHoldsResponseBackpressure(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major > 1 || (major === 1 && minor >= 4);
}

/**
 * Downloads one controller streams at once. Where the runtime buffers a slow
 * download in memory, fewer, so the worst case stays near 2 × the cap.
 */
export function maxLiveDownloads(version: string): number {
  return runtimeHoldsResponseBackpressure(version) ? 8 : 2;
}
