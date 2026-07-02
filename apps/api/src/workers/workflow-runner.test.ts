import { describe, expect, it } from 'bun:test';
import type { WorkflowRunState, WorkflowStepDef } from '@swarmy/core';
import {
  advanceState,
  buildWebhookBody,
  delayOutcome,
  isParked,
  outcomeFromRunOnce,
  parseRunState,
  parseSteps,
  retryBackoffMs,
  signWebhookBody,
  type RunSnapshot,
} from './workflow-runner';

/**
 * The workflow step-transition reducer is PURE — these tests pin every kind
 * and path: succeed-and-advance, succeed-and-finish, fail, approval park,
 * delay park/elapse, plus the codecs and webhook helpers around it.
 */

const state = (over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  input: { doc: 42 },
  steps: [],
  ...over,
});

const snap = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  cursor: 0,
  totalSteps: 3,
  state: state(),
  ...over,
});

describe('advanceState', () => {
  it('succeeded mid-run: records output, advances cursor, stays running', () => {
    const next = advanceState(snap(), 'extract', { kind: 'succeeded', output: { exitCode: 0 } });
    expect(next.runStatus).toBe('running');
    expect(next.cursor).toBe(1);
    expect(next.finished).toBe(false);
    expect(next.stepStatus).toBe('succeeded');
    expect(next.state.steps).toEqual([{ name: 'extract', output: { exitCode: 0 } }]);
  });

  it('succeeded on the LAST step finishes the run', () => {
    const next = advanceState(snap({ cursor: 2 }), 'publish', { kind: 'succeeded' });
    expect(next.runStatus).toBe('succeeded');
    expect(next.cursor).toBe(3);
    expect(next.finished).toBe(true);
    expect(next.state.steps).toEqual([{ name: 'publish' }]);
  });

  it('succeeded clears a leftover delay park', () => {
    const parked = snap({ state: state({ nextEligibleAt: '2026-07-02T00:00:00.000Z' }) });
    const next = advanceState(parked, 'cool-down', { kind: 'succeeded', output: { delayedSeconds: 60 } });
    expect(next.state.nextEligibleAt).toBeUndefined();
  });

  it('failed: records the error and finishes the run as failed', () => {
    const before = snap({ cursor: 1, state: state({ steps: [{ name: 'extract', output: 'ok' }] }) });
    const next = advanceState(before, 'notify', { kind: 'failed', error: 'HTTP 500: boom' });
    expect(next.runStatus).toBe('failed');
    expect(next.cursor).toBe(1); // cursor stays on the failed step
    expect(next.finished).toBe(true);
    expect(next.stepStatus).toBe('failed');
    expect(next.state.steps).toEqual([
      { name: 'extract', output: 'ok' },
      { name: 'notify', error: 'HTTP 500: boom' },
    ]);
  });

  it('approval-pending parks the run without moving the cursor', () => {
    const next = advanceState(snap({ cursor: 1 }), 'sign-off', { kind: 'approval-pending' });
    expect(next.runStatus).toBe('waiting-approval');
    expect(next.cursor).toBe(1);
    expect(next.finished).toBe(false);
    expect(next.stepStatus).toBe('waiting');
    expect(next.state.steps).toEqual([]); // nothing recorded until the decision
  });

  it('delay-pending stamps nextEligibleAt and keeps the run running', () => {
    const next = advanceState(snap(), 'cool-down', {
      kind: 'delay-pending',
      resumeAt: '2026-07-02T12:00:00.000Z',
    });
    expect(next.runStatus).toBe('running');
    expect(next.cursor).toBe(0);
    expect(next.finished).toBe(false);
    expect(next.stepStatus).toBe('running');
    expect(next.state.nextEligibleAt).toBe('2026-07-02T12:00:00.000Z');
  });

  it('is pure: never mutates the input snapshot', () => {
    const before = snap({ state: state({ steps: [{ name: 'a', output: 1 }] }) });
    advanceState(before, 'b', { kind: 'succeeded', output: 2 });
    advanceState(before, 'b', { kind: 'failed', error: 'x' });
    expect(before.state.steps).toEqual([{ name: 'a', output: 1 }]);
    expect(before.state.nextEligibleAt).toBeUndefined();
    expect(before.cursor).toBe(0);
  });
});

describe('delayOutcome', () => {
  const step: WorkflowStepDef = { name: 'cool-down', kind: 'delay', config: { seconds: 60 } };
  const now = new Date('2026-07-02T10:00:00.000Z');

  it('parks an unparked run for config.seconds', () => {
    expect(delayOutcome(step, state(), now)).toEqual({
      kind: 'delay-pending',
      resumeAt: '2026-07-02T10:01:00.000Z',
    });
  });

  it('keeps waiting while nextEligibleAt is in the future', () => {
    const parked = state({ nextEligibleAt: '2026-07-02T10:00:30.000Z' });
    expect(delayOutcome(step, parked, now)).toEqual({
      kind: 'delay-pending',
      resumeAt: '2026-07-02T10:00:30.000Z',
    });
  });

  it('succeeds once the park has elapsed', () => {
    const parked = state({ nextEligibleAt: '2026-07-02T09:59:59.000Z' });
    expect(delayOutcome(step, parked, now)).toEqual({
      kind: 'succeeded',
      output: { delayedSeconds: 60 },
    });
  });

  it('fails a delay step with no seconds', () => {
    const bad: WorkflowStepDef = { name: 'cool-down', kind: 'delay', config: {} };
    expect(delayOutcome(bad, state(), now).kind).toBe('failed');
  });
});

describe('isParked', () => {
  const now = new Date('2026-07-02T10:00:00.000Z');
  it('true only for a future nextEligibleAt', () => {
    expect(isParked(state(), now)).toBe(false);
    expect(isParked(state({ nextEligibleAt: '2026-07-02T10:00:01.000Z' }), now)).toBe(true);
    expect(isParked(state({ nextEligibleAt: '2026-07-02T10:00:00.000Z' }), now)).toBe(false);
  });
});

describe('webhook helpers', () => {
  it('body carries runId, input and the PREVIOUS step output', () => {
    const st = state({
      steps: [
        { name: 'a', output: { rows: 3 } },
        { name: 'b', output: 'done' },
      ],
    });
    expect(JSON.parse(buildWebhookBody('run-1', st))).toEqual({
      runId: 'run-1',
      input: { doc: 42 },
      prevOutput: 'done',
    });
  });

  it('body nulls input/prevOutput when absent', () => {
    expect(JSON.parse(buildWebhookBody('run-1', { input: null, steps: [] }))).toEqual({
      runId: 'run-1',
      input: null,
      prevOutput: null,
    });
  });

  it('signs with sha256=<hmac-hex> (webhooks-out convention)', () => {
    const sig = signWebhookBody('shhh', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).toBe(signWebhookBody('shhh', '{"a":1}')); // deterministic
    expect(sig).not.toBe(signWebhookBody('other', '{"a":1}'));
  });
});

describe('outcomeFromRunOnce', () => {
  it('exit 0 → succeeded with the output tail', () => {
    expect(outcomeFromRunOnce({ exitCode: 0, output: 'hello' })).toEqual({
      kind: 'succeeded',
      output: { exitCode: 0, output: 'hello' },
    });
  });
  it('non-zero exit → failed', () => {
    const out = outcomeFromRunOnce({ exitCode: 2, output: 'boom' });
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.error).toContain('exit code 2');
  });
  it('timedOut → failed even with exit 0', () => {
    expect(outcomeFromRunOnce({ exitCode: 0, output: '', timedOut: true }).kind).toBe('failed');
  });
});

describe('codecs', () => {
  it('parseSteps keeps valid steps and drops junk rows/fields', () => {
    const steps = parseSteps([
      { name: 'run', kind: 'container', config: { image: 'alpine', command: ['sh', 1], env: { A: 'x', B: 2 } } },
      { name: 'ask', kind: 'approval', config: { prompt: 'ok?' }, timeoutMs: 5_000, retries: 2 },
      { name: 'bad-kind', kind: 'teleport', config: {} },
      'garbage',
      null,
      { kind: 'delay' },
    ]);
    expect(steps).toEqual([
      { name: 'run', kind: 'container', config: { image: 'alpine', command: ['sh'], env: { A: 'x' } } },
      { name: 'ask', kind: 'approval', config: { prompt: 'ok?' }, timeoutMs: 5_000, retries: 2 },
    ]);
  });

  it('parseRunState tolerates junk and preserves the park', () => {
    expect(parseRunState(null)).toEqual({ input: null, steps: [] });
    expect(parseRunState([1, 2])).toEqual({ input: null, steps: [] });
    expect(
      parseRunState({
        input: 'x',
        steps: [{ name: 'a', output: 1 }, 'junk', { name: 'b', error: 'e' }],
        nextEligibleAt: '2026-07-02T10:00:00.000Z',
      }),
    ).toEqual({
      input: 'x',
      steps: [
        { name: 'a', output: 1 },
        { name: 'b', error: 'e' },
      ],
      nextEligibleAt: '2026-07-02T10:00:00.000Z',
    });
  });
});

describe('retryBackoffMs', () => {
  it('doubles from 5s capped at 60s', () => {
    expect([1, 2, 3, 4, 5].map(retryBackoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
  });
});
