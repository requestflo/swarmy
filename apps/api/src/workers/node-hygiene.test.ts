import { describe, expect, it } from 'bun:test';
import { HYGIENE_INTERVAL_MS, HYGIENE_PRESSURE_COOLDOWN_MS, hygieneDue } from './node-hygiene.core';

const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;

describe('hygieneDue — the node-hygiene worker schedule', () => {
  it('runs a node never cleaned this lifetime, then waits the 6h interval', () => {
    expect(hygieneDue({ lastRunMs: undefined, diskUsedBytes: 1, diskTotalBytes: 10, now: NOW })).toBe(true);
    expect(hygieneDue({ lastRunMs: NOW - 60_000, diskUsedBytes: 5 * GB, diskTotalBytes: 25 * GB, now: NOW })).toBe(false);
    expect(hygieneDue({ lastRunMs: NOW - HYGIENE_INTERVAL_MS, diskUsedBytes: 5 * GB, diskTotalBytes: 25 * GB, now: NOW })).toBe(true);
  });

  it('runs sooner under disk pressure (>85%), after a 30 min cooldown', () => {
    const full = { diskUsedBytes: 23 * GB, diskTotalBytes: 25 * GB };
    expect(hygieneDue({ lastRunMs: NOW - 5 * 60_000, ...full, now: NOW })).toBe(false);
    expect(hygieneDue({ lastRunMs: NOW - HYGIENE_PRESSURE_COOLDOWN_MS, ...full, now: NOW })).toBe(true);
    // Unknown disk stats never trigger the pressure path.
    expect(hygieneDue({ lastRunMs: NOW - HYGIENE_PRESSURE_COOLDOWN_MS, diskUsedBytes: null, diskTotalBytes: null, now: NOW })).toBe(false);
  });
});
