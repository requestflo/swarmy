import { describe, expect, it } from 'bun:test';
import type { ContainerStatsSnapshot } from '@swarmy/core';
import { summarizeUsage } from './service-usage';

const sample = (cpuPercent: number, memUsedBytes: number): ContainerStatsSnapshot => ({
  containerId: `c${cpuPercent}`,
  name: 'api.1',
  cpuPercent,
  memUsedBytes,
  memLimitBytes: 512 * 1024 ** 2,
  netRxBytes: 0,
  netTxBytes: 0,
});

describe('summarizeUsage', () => {
  it('is null with no samples (never a fake zero)', () => {
    expect(summarizeUsage([], 1)).toBeNull();
  });

  it('reports per-copy average and peak; 100% CPU is one core', () => {
    const u = summarizeUsage([sample(20, 200 * 1024 ** 2), sample(40, 311 * 1024 ** 2)], 5)!;
    expect(u.sampled).toBe(2);
    expect(u.cpuCores.avg).toBeCloseTo(0.3);
    expect(u.cpuCores.peak).toBeCloseTo(0.4);
    expect(u.memBytes.peak).toBe(311 * 1024 ** 2);
    expect(u.ts).toBe(5);
  });
});
