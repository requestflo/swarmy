import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { DEFAULT_DOWNLOAD_MAX_BYTES } from '@swarmy/core';

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

/**
 * Where the runtime buffers a slow download (above), what one controller may
 * hold in memory: about a quarter of it across live downloads. Unless the
 * operator set `SWARMY_BACKUP_DOWNLOAD_MAX_BYTES`, the cap shrinks to an eighth
 * of memory (never above the 2 GiB default), and as many downloads stream at
 * once as fit in the quarter (1 or 2). A cap the operator set is kept, with one
 * download at a time if it doesn't fit. Pure.
 */
export function bufferedDownloadBudget(memoryBytes: number, operatorCap: number | null): { cap: number; maxLive: number } {
  const cap = operatorCap ?? Math.max(64 * 1024 ** 2, Math.min(DEFAULT_DOWNLOAD_MAX_BYTES, Math.floor(memoryBytes / 8)));
  return { cap, maxLive: Math.max(1, Math.min(2, Math.floor(memoryBytes / 4 / cap))) };
}

/** The memory this controller may use: its cgroup limit when it has one (a container), else the host's. */
export function controllerMemoryBytes(read: (path: string) => string | null = readOrNull, host: number = totalmem()): number {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const n = Number.parseInt(read(path)?.trim() ?? '', 10);
    if (Number.isSafeInteger(n) && n > 0 && n < host) return n;
  }
  return host;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
