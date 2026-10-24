import { describe, expect, test } from 'bun:test';
import type { HealthCopyView, HealthTestView } from '@swarmy/core';
import { probeLine, sayMs, summarizeProbes, testLine } from './probe-model';

const copy = (probes: [number, number, number][]): HealthCopyView => ({
  nodeId: 'n1',
  node: 'wkr-1',
  containerId: 'c1',
  status: 'healthy',
  failingStreak: 0,
  probes: probes.map(([at, durationMs, exitCode]) => ({ at, durationMs, exitCode })),
});

const at = (min: number): number => Date.UTC(2026, 9, 24, 10, min);
const utc = (t: number): string => new Date(t).toISOString().slice(11, 16);

describe('summarizeProbes — over what Docker kept', () => {
  test('counts the real probes across copies, with the slow one and the misses', () => {
    const s = summarizeProbes([
      copy([[at(30), 4, 0], [at(30), 3.8, 0], [at(31), 212, 0], [at(31), 4.2, 0], [at(32), 4, 0]]),
      copy([[at(30), 5, 0], [at(31), 4, 0], [at(32), 3.9, 0], [at(32), 4, 0], [at(33), 4.4, 0]]),
    ]);
    expect(s).toEqual({ count: 10, copies: 2, p50Ms: 4, slow: [{ ms: 212, at: at(31) }], misses: 0 });
    expect(probeLine(s!, utc)).toBe('p50 4 ms · one slow 212 ms at 10:31 · 0 misses');
  });

  test('misses are failed probes; several slow ones are summed up', () => {
    const s = summarizeProbes([copy([[1, 300, 0], [2, 400, 0], [3, 5, 1], [4, 6, 0], [5, 5, 0]])])!;
    expect(s.misses).toBe(1);
    expect(probeLine(s, utc)).toBe('p50 6 ms · 2 slow, up to 400 ms · 1 miss');
  });

  test('no probes is null, never a fake zero', () => {
    expect(summarizeProbes([])).toBeNull();
    expect(summarizeProbes([copy([])])).toBeNull();
  });

  test('durations', () => {
    expect([0.42, 4.25, 212.4, 1450].map(sayMs)).toEqual(['0.4 ms', '4.3 ms', '212 ms', '1.5 s']);
  });
});

describe('testLine', () => {
  const r: HealthTestView = { ok: true, exitCode: 0, timedOut: false, durationMs: 4.2, output: '', at: 0, node: 'wkr-1', containerId: 'c1', cmd: ['true'] };
  test('says the result, the exit code and the time', () => {
    expect(testLine(r)).toBe('Passed in 4.2 ms on wkr-1.');
    expect(testLine({ ...r, ok: false, exitCode: 7, durationMs: 12 })).toBe('Failed with exit code 7 after 12 ms on wkr-1.');
    expect(testLine({ ...r, ok: false, exitCode: null, timedOut: true, durationMs: 30_000, node: null })).toBe('No answer within 30 s. Docker would count that as a miss.');
  });
});
