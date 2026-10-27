import { describe, expect, it } from 'bun:test';
import { bufferedDownloadBudget, controllerMemoryBytes, maxLiveDownloads, runtimeHoldsResponseBackpressure } from './runtime';

describe('runtime response backpressure (measured on 1.3.14 vs 1.4.4)', () => {
  it('1.3.x buffers; 1.4+ holds', () => {
    expect(runtimeHoldsResponseBackpressure('1.3.14')).toBe(false);
    expect(runtimeHoldsResponseBackpressure('1.4.4')).toBe(true);
    expect(runtimeHoldsResponseBackpressure('2.0.0')).toBe(true);
  });

  it('streams fewer downloads at once where the runtime buffers them', () => {
    expect(maxLiveDownloads('1.3.14')).toBe(2);
    expect(maxLiveDownloads('1.4.4')).toBe(8);
  });
});

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe('what a buffering runtime may hold (a quarter of memory)', () => {
  it('a small controller gets a smaller default cap, two at once', () => {
    expect(bufferedDownloadBudget(1 * GiB, null)).toEqual({ cap: 128 * MiB, maxLive: 2 });
    expect(bufferedDownloadBudget(4 * GiB, null)).toEqual({ cap: 512 * MiB, maxLive: 2 });
  });

  it('never above the 2 GiB default, and never below 64 MiB', () => {
    expect(bufferedDownloadBudget(64 * GiB, null)).toEqual({ cap: 2 * GiB, maxLive: 2 });
    expect(bufferedDownloadBudget(256 * MiB, null).cap).toBe(64 * MiB);
  });

  it("keeps the operator's cap, one at a time when it doesn't fit", () => {
    expect(bufferedDownloadBudget(2 * GiB, 2 * GiB)).toEqual({ cap: 2 * GiB, maxLive: 1 });
    expect(bufferedDownloadBudget(16 * GiB, 1 * GiB)).toEqual({ cap: 1 * GiB, maxLive: 2 });
  });
});

describe('controller memory', () => {
  const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;
  it('a cgroup v2 or v1 limit under the host wins', () => {
    expect(controllerMemoryBytes(files({ '/sys/fs/cgroup/memory.max': `${GiB}\n` }), 8 * GiB)).toBe(GiB);
    expect(controllerMemoryBytes(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${2 * GiB}` }), 8 * GiB)).toBe(2 * GiB);
  });

  it('"max", an unset limit or one above the host falls back to the host', () => {
    expect(controllerMemoryBytes(files({ '/sys/fs/cgroup/memory.max': 'max' }), 8 * GiB)).toBe(8 * GiB);
    expect(controllerMemoryBytes(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }), 8 * GiB)).toBe(8 * GiB);
    expect(controllerMemoryBytes(files({}), 8 * GiB)).toBe(8 * GiB);
  });
});
