import { describe, expect, it } from 'bun:test';
import { failureLine, median, scanStage, stageMs, toStageViews, usualStageMs, type StageRow } from './build-stages';

const T0 = Date.parse('2026-10-24T10:42:00.000Z');
const at = (s: number): Date => new Date(T0 + s * 1000);
const row = (stage: string, from: number, to: number | null, outcome = 'ok'): StageRow => ({
  stage,
  startedAt: at(from),
  finishedAt: to === null ? null : at(to),
  outcome,
});
const build = (status: string, startedAt: number, stages: StageRow[]) => ({ status, startedAt: at(startedAt), stages });

describe('median', () => {
  it('is the middle value, or the rounded mean of the middle two', () => {
    expect(median([])).toBeNull();
    expect(median([9])).toBe(9);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 41])).toBe(25);
  });
});

describe('usualStageMs', () => {
  it('takes the median per stage over successful builds only', () => {
    const history = [
      build('SUCCEEDED', 300, [row('clone', 300, 302), row('build', 302, 340)]),
      build('SUCCEEDED', 200, [row('clone', 200, 203), row('build', 203, 245)]),
      build('SUCCEEDED', 100, [row('clone', 100, 101), row('build', 101, 141)]),
      // A failed build never sets "usually", however slow it was.
      build('FAILED', 400, [row('clone', 400, 460), row('build', 460, 900, 'failed')]),
    ];
    expect(usualStageMs(history)).toEqual({ clone: 2_000, build: 40_000 });
  });

  it('counts only stages that finished well (ok or warn)', () => {
    const history = [
      build('SUCCEEDED', 10, [row('scan', 10, 17, 'warn'), row('rollout', 20, 30, 'failed')]),
      build('SUCCEEDED', 20, [row('scan', 20, 29), row('rollout', 30, null, 'running')]),
    ];
    expect(usualStageMs(history)).toEqual({ scan: 8_000 });
  });

  it('looks at the newest N successful builds, whatever order they arrive in', () => {
    const history = [
      build('SUCCEEDED', 1, [row('push', 1, 101)]), // oldest: outside a sample of 2
      build('SUCCEEDED', 300, [row('push', 300, 303)]),
      build('SUCCEEDED', 200, [row('push', 200, 205)]),
    ];
    expect(usualStageMs(history, 2)).toEqual({ push: 4_000 });
    expect(usualStageMs(history)).toEqual({ push: 5_000 });
  });

  it('has no "usually" without a sample', () => {
    expect(usualStageMs([])).toEqual({});
    expect(usualStageMs([build('SUCCEEDED', 1, [])])).toEqual({});
  });
});

describe('toStageViews', () => {
  it('orders clone → rollout, drops unknown stages and keeps facts', () => {
    const views = toStageViews([
      { ...row('rollout', 60, 70), factsJson: { rollout: { stack: 'shop', services: ['checkout'], ready: 3, desired: 3, drained: true } } },
      row('clone', 0, 2),
      row('deploy', 0, 1),
      row('build', 2, null, 'running'),
    ]);
    expect(views.map((v) => v.key)).toEqual(['clone', 'build', 'rollout']);
    expect(views[1]).toEqual({ key: 'build', startedAt: at(2).toISOString(), finishedAt: null, outcome: 'running', facts: {} });
    expect(views[2]?.facts.rollout?.drained).toBe(true);
  });

  it('reads an unknown outcome as still running', () => {
    expect(toStageViews([row('scan', 0, 1, 'weird')])[0]?.outcome).toBe('running');
  });
});

describe('stage readers', () => {
  it('stageMs is null while a stage runs', () => {
    expect(stageMs(row('build', 0, 38))).toBe(38_000);
    expect(stageMs(row('build', 0, null))).toBeNull();
  });

  it('scanStage: clean is ok, critical/high is a warning, an error failed', () => {
    const scan = { status: 'passed' as const, criticalCount: 0, highCount: 0, mediumCount: 2, lowCount: 5 };
    expect(scanStage(scan)).toEqual({ outcome: 'ok', facts: { scan: { critical: 0, high: 0, medium: 2, low: 5 } } });
    expect(scanStage({ ...scan, highCount: 1 }).outcome).toBe('warn');
    expect(scanStage({ ...scan, status: 'error' }).outcome).toBe('failed');
  });

  it('failureLine keeps the first line, short', () => {
    expect(failureLine(new Error('build exited 1\n#7 ERROR: tail'))).toBe('build exited 1');
    expect(failureLine('x'.repeat(500))).toHaveLength(200);
  });
});
