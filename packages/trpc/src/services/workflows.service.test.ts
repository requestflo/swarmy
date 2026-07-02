import { describe, expect, it } from 'bun:test';
import type { WorkflowStepInput } from '@swarmy/core';
import {
  parseRunState,
  parseSteps,
  parseTriggerInput,
  prettyJson,
  toStepView,
  toStoredSteps,
  validateSteps,
} from './workflows.service';

/**
 * Pure workflow codecs + validation (canonical copies; the workflow-runner
 * worker mirrors the codecs and pins its own reducer in apps/api).
 */

const step = (over: Partial<WorkflowStepInput>): WorkflowStepInput => ({
  name: 'step-1',
  kind: 'container',
  config: { image: 'alpine:3', command: ['true'] },
  ...over,
});

describe('validateSteps', () => {
  it('accepts one valid step of every kind', () => {
    expect(
      validateSteps([
        step({ name: 'build', kind: 'container', config: { image: 'alpine:3' } }),
        step({ name: 'migrate', kind: 'service-exec', config: { serviceRef: 'api', command: ['./migrate'] } }),
        step({ name: 'notify', kind: 'webhook', config: { url: 'https://example.com/hook' } }),
        step({ name: 'sign-off', kind: 'approval', config: { prompt: 'Ship it?' } }),
        step({ name: 'cool-down', kind: 'delay', config: { seconds: 300 } }),
      ]),
    ).toEqual([]);
  });

  it('rejects an empty workflow', () => {
    expect(validateSteps([])).toEqual(['a workflow needs at least one step']);
  });

  it('rejects duplicate step names', () => {
    const problems = validateSteps([step({}), step({})]);
    expect(problems.join(' ')).toContain('duplicate step name');
  });

  it('requires an image for container steps', () => {
    expect(validateSteps([step({ config: {} })]).join(' ')).toContain('need an image');
  });

  it('requires serviceRef AND command for service-exec steps', () => {
    const problems = validateSteps([step({ kind: 'service-exec', config: {} })]);
    expect(problems.join(' ')).toContain('target service');
    expect(problems.join(' ')).toContain('need a command');
  });

  it('requires an http(s) URL for webhook steps', () => {
    expect(validateSteps([step({ kind: 'webhook', config: { url: 'ftp://x' } })]).join(' ')).toContain('http(s)');
    expect(validateSteps([step({ kind: 'webhook', config: {} })]).join(' ')).toContain('http(s)');
  });

  it('requires seconds ≥ 1 for delay steps', () => {
    expect(validateSteps([step({ kind: 'delay', config: {} })]).join(' ')).toContain('seconds');
  });
});

describe('toStoredSteps (secret handling)', () => {
  const enc = (plain: string): string => `enc(${plain})`;

  it('encrypts a submitted webhook secret; plaintext never stored', () => {
    const stored = toStoredSteps(
      [step({ kind: 'webhook', config: { url: 'https://x.dev/h', secret: 'shhh' } })],
      [],
      enc,
    );
    expect(stored[0]!.config.secretEnc).toBe('enc(shhh)');
    expect(JSON.stringify(stored)).not.toContain('"secret"');
    expect(JSON.stringify(stored)).not.toContain('shhh"');
  });

  it('carries the previous version’s secret when omitted on edit', () => {
    const previous = parseSteps([
      { name: 'notify', kind: 'webhook', config: { url: 'https://x.dev/h', secretEnc: 'enc(old)' } },
    ]);
    const stored = toStoredSteps(
      [step({ name: 'notify', kind: 'webhook', config: { url: 'https://x.dev/h2' } })],
      previous,
      enc,
    );
    expect(stored[0]!.config.secretEnc).toBe('enc(old)');
    expect(stored[0]!.config.url).toBe('https://x.dev/h2');
  });

  it('a re-submitted secret replaces the carried one', () => {
    const previous = parseSteps([
      { name: 'notify', kind: 'webhook', config: { url: 'https://x.dev/h', secretEnc: 'enc(old)' } },
    ]);
    const stored = toStoredSteps(
      [step({ name: 'notify', kind: 'webhook', config: { url: 'https://x.dev/h', secret: 'new' } })],
      previous,
      enc,
    );
    expect(stored[0]!.config.secretEnc).toBe('enc(new)');
  });

  it('keeps timeout/retries and non-secret config verbatim', () => {
    const stored = toStoredSteps([step({ timeoutMs: 30_000, retries: 2 })], [], enc);
    expect(stored[0]).toEqual({
      name: 'step-1',
      kind: 'container',
      config: { image: 'alpine:3', command: ['true'] },
      timeoutMs: 30_000,
      retries: 2,
    });
  });
});

describe('toStepView', () => {
  it('reduces a stored secret to hasSecret and never leaks the blob', () => {
    const [stored] = toStoredSteps(
      [step({ kind: 'webhook', config: { url: 'https://x.dev/h', secret: 's' } })],
      [],
      (p) => `enc(${p})`,
    );
    const view = toStepView(stored!);
    expect(view.config).toEqual({ url: 'https://x.dev/h', hasSecret: true });
    expect(JSON.stringify(view)).not.toContain('enc(');
  });

  it('defaults timeout/retries to null', () => {
    const view = toStepView({ name: 'a', kind: 'approval', config: {} });
    expect(view.timeoutMs).toBeNull();
    expect(view.retries).toBeNull();
  });
});

describe('codecs', () => {
  it('parseSteps drops junk rows, unknown kinds and non-string command items', () => {
    expect(
      parseSteps([
        { name: 'ok', kind: 'container', config: { image: 'a', command: ['x', 7] } },
        { name: 'nope', kind: 'teleport', config: {} },
        null,
        'junk',
      ]),
    ).toEqual([{ name: 'ok', kind: 'container', config: { image: 'a', command: ['x'] } }]);
    expect(parseSteps('not-an-array')).toEqual([]);
  });

  it('parseRunState is defensive and preserves the park', () => {
    expect(parseRunState(undefined)).toEqual({ input: null, steps: [] });
    expect(
      parseRunState({ input: { a: 1 }, steps: [{ name: 's', output: 'o' }], nextEligibleAt: '2026-01-01T00:00:00Z' }),
    ).toEqual({ input: { a: 1 }, steps: [{ name: 's', output: 'o' }], nextEligibleAt: '2026-01-01T00:00:00Z' });
  });

  it('parseTriggerInput: JSON when it parses, raw string otherwise, null when empty', () => {
    expect(parseTriggerInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseTriggerInput('plain text')).toBe('plain text');
    expect(parseTriggerInput('   ')).toBeNull();
    expect(parseTriggerInput(undefined)).toBeNull();
  });

  it('prettyJson: strings verbatim, objects pretty-printed, nulls null, bounded', () => {
    expect(prettyJson(null)).toBeNull();
    expect(prettyJson(undefined)).toBeNull();
    expect(prettyJson('raw')).toBe('raw');
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson('x'.repeat(10_000))!.length).toBeLessThanOrEqual(8_193);
  });
});
