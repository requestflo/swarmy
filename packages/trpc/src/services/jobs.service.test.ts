import { describe, expect, it } from 'bun:test';
import {
  matchesNodeLabels,
  outcomeFromError,
  outcomeFromRunOnce,
  parseCommand,
  parseEnv,
  parseRunOn,
  previewSchedule,
  retryBackoffMs,
  validateJobConfig,
} from './jobs.service';

describe('validateJobConfig', () => {
  const base = {
    schedule: '0 2 * * *',
    command: ['sh', '-c', 'echo hi'],
    env: {},
  };

  it('accepts a valid image job', () => {
    expect(validateJobConfig({ ...base, kind: 'image', image: 'alpine:3' })).toEqual([]);
  });

  it('accepts a valid service-exec job', () => {
    expect(validateJobConfig({ ...base, kind: 'service-exec', serviceRef: 'shop_api' })).toEqual([]);
  });

  it('rejects a bad cron with the parser message', () => {
    const problems = validateJobConfig({ ...base, kind: 'image', image: 'alpine:3', schedule: '61 * * * *' });
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/minute/);
  });

  it('requires image for image jobs and serviceRef for service-exec jobs', () => {
    expect(validateJobConfig({ ...base, kind: 'image' })).toEqual(['image jobs need an image']);
    expect(validateJobConfig({ ...base, kind: 'service-exec', serviceRef: '  ' })).toEqual([
      'service-exec jobs need a target service',
    ]);
  });

  it('requires a command', () => {
    expect(validateJobConfig({ ...base, kind: 'image', image: 'alpine:3', command: [] })).toEqual([
      'a command is required',
    ]);
  });

  it('rejects invalid env var names', () => {
    expect(
      validateJobConfig({ ...base, kind: 'image', image: 'alpine:3', env: { 'BAD-KEY': 'x' } }),
    ).toEqual(['invalid env var name "BAD-KEY"']);
  });

  it('collects multiple problems', () => {
    expect(validateJobConfig({ kind: 'image', schedule: 'nope', command: [], env: {} }).length).toBe(3);
  });
});

describe('JSON column codecs', () => {
  it('parseCommand keeps only strings and survives junk', () => {
    expect(parseCommand(['a', 1, 'b', null])).toEqual(['a', 'b']);
    expect(parseCommand('not-an-array')).toEqual([]);
    expect(parseCommand(null)).toEqual([]);
  });

  it('parseEnv keeps only string values', () => {
    expect(parseEnv({ A: '1', B: 2, C: 'x' })).toEqual({ A: '1', C: 'x' });
    expect(parseEnv([])).toEqual({});
    expect(parseEnv(null)).toEqual({});
  });

  it('parseRunOn extracts nodeId and labels defensively', () => {
    expect(parseRunOn({ nodeId: 'n1', labels: { gpu: 'true', bad: 1 } })).toEqual({
      nodeId: 'n1',
      labels: { gpu: 'true' },
    });
    expect(parseRunOn({ nodeId: '', labels: {} })).toEqual({});
    expect(parseRunOn('junk')).toEqual({});
  });
});

describe('matchesNodeLabels', () => {
  it('requires every wanted label to match exactly', () => {
    expect(matchesNodeLabels({ gpu: 'true', region: 'eu' }, { gpu: 'true' })).toBe(true);
    expect(matchesNodeLabels({ gpu: 'false' }, { gpu: 'true' })).toBe(false);
    expect(matchesNodeLabels(undefined, { gpu: 'true' })).toBe(false);
    expect(matchesNodeLabels(undefined, {})).toBe(true);
  });
});

describe('retryBackoffMs', () => {
  it('doubles from 5s and caps at 60s', () => {
    expect(retryBackoffMs(1)).toBe(5_000);
    expect(retryBackoffMs(2)).toBe(10_000);
    expect(retryBackoffMs(3)).toBe(20_000);
    expect(retryBackoffMs(5)).toBe(60_000);
    expect(retryBackoffMs(10)).toBe(60_000);
  });
});

describe('attempt outcomes', () => {
  it('maps runOnce results to succeeded/failed/timeout', () => {
    expect(outcomeFromRunOnce({ exitCode: 0, output: 'ok' })).toEqual({
      status: 'succeeded',
      exitCode: 0,
      output: 'ok',
    });
    expect(outcomeFromRunOnce({ exitCode: 2, output: 'boom' }).status).toBe('failed');
    expect(outcomeFromRunOnce({ exitCode: 137, output: '', timedOut: true }).status).toBe('timeout');
  });

  it('maps dispatch errors, detecting timeouts by message', () => {
    expect(outcomeFromError(new Error('agent did not respond in time (timeout)')).status).toBe('timeout');
    const failed = outcomeFromError(new Error('node offline'));
    expect(failed.status).toBe('failed');
    expect(failed.output).toBe('node offline');
    expect(failed.exitCode).toBeNull();
  });
});

describe('previewSchedule', () => {
  const from = new Date('2026-07-02T10:00:00Z');

  it('returns description + next occurrences for a valid cron', () => {
    const p = previewSchedule({ schedule: '0 2 * * *', count: 3 }, from);
    expect(p.valid).toBe(true);
    expect(p.error).toBeNull();
    expect(p.scheduleText).toBe('every day 02:00');
    expect(p.next).toEqual([
      '2026-07-03T02:00:00.000Z',
      '2026-07-04T02:00:00.000Z',
      '2026-07-05T02:00:00.000Z',
    ]);
  });

  it('reports invalid crons without throwing', () => {
    const p = previewSchedule({ schedule: '0 2 * *', count: 3 }, from);
    expect(p.valid).toBe(false);
    expect(p.next).toEqual([]);
    expect(p.error).toMatch(/5 fields/);
  });
});
