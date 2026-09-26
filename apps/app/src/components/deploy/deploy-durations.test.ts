import { describe, expect, it } from 'bun:test';
import { stepDurations } from './deploy-durations';
import type { DeployStep } from './deploy-steps';

const step = (key: DeployStep['key']): DeployStep => ({ key, title: key, sub: '', state: 'done', tech: null });
const STEPS = [step('image'), step('data'), step('start'), step('https'), step('health')];

describe('stepDurations (the tracker shows how long each step took)', () => {
  it('a streamed step: done minus its own start, so parallel steps each keep their time', () => {
    expect(stepDurations(STEPS, { image: 12, data: 9, start: 20 }, { image: 0, data: 0, start: 13 })).toEqual({ image: 12, data: 9, start: 7 });
  });

  it('a polled step: timed from the end of the step before it', () => {
    expect(stepDurations(STEPS, { image: 12, data: 21, start: 28 }, {})).toEqual({ image: 12, data: 9, start: 7 });
  });

  it('never negative, and steps not done yet have no time', () => {
    expect(stepDurations(STEPS, { image: 12, data: 5 }, {})).toEqual({ image: 12, data: 0 });
    expect(stepDurations(STEPS, {}, {})).toEqual({});
  });
});
