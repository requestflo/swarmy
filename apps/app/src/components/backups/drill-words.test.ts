import { describe, expect, test } from 'bun:test';
import type { ResilienceDrillResultView } from '@swarmy/core';
import { drillOutcome, restoredBytes, stepWords } from './drill-words';

const passed: ResilienceDrillResultView = {
  kind: 'restore',
  status: 'passed',
  at: '2026-10-21T04:10:00Z',
  durationMs: 471_000,
  target: 'data/main',
  summary: 'Restored a1b2c3d4 into drill-lyx2m9, verified SELECT 1, destroyed the clone.',
  steps: [
    { name: 'Create throwaway cluster', status: 'passed', detail: 'deployed data_drill-lyx2m9-primary', durationMs: 44_000 },
    { name: 'Wait for postgres', status: 'passed', detail: null, durationMs: 24_000 },
    { name: 'Restore snapshot a1b2c3d4', status: 'passed', detail: '398163968 bytes restored', durationMs: 401_000 },
    { name: 'Verify SELECT 1', status: 'passed', detail: null, durationMs: 850 },
    { name: 'Destroy the clone', status: 'passed', detail: null, durationMs: 3_100 },
  ],
  error: null,
};

describe('stepWords', () => {
  test('the service’s step names in plain words', () => {
    expect(passed.steps.map((s) => stepWords(s.name))).toEqual([
      'Start a throwaway copy',
      'Wait for it to answer',
      'Put the latest save into it',
      'Check it answers',
      'Delete the copy',
    ]);
    expect(stepWords('restic check on "Backblaze B2"')).toBe('Check every save in Backblaze B2');
    expect(stepWords('Something new')).toBe('Something new');
  });
});

describe('drillOutcome', () => {
  test('a pass says how much came back', () => {
    expect(restoredBytes(passed)).toBe('398163968');
    expect(drillOutcome(passed)).toBe('Restored 379.7 MB and it answered.');
  });
  test('a failure names the step it stopped at', () => {
    const failed: ResilienceDrillResultView = {
      ...passed,
      status: 'failed',
      steps: [passed.steps[0]!, { name: 'Wait for postgres', status: 'failed', detail: 'no space left on device', durationMs: 120_000 }],
      error: 'no space left on device',
    };
    expect(drillOutcome(failed)).toBe('It stopped at “wait for it to answer”. Nothing live was touched.');
  });
  test('a verify pass', () => {
    expect(drillOutcome({ ...passed, kind: 'backup-verify', steps: [] })).toBe('Every save in the destination is whole.');
  });
});
