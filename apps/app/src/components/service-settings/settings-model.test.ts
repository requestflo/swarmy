import { describe, expect, test } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { changedLines, composeOf } from './settings-compose';
import { MIB, applyDraft, applySentence, draftChanges, fmtMem, rolloutSeconds, toCalls } from './settings-model';

const spec: ServiceSpec = {
  name: 'storefront_api',
  image: 'registry.northwind.dev/storefront/api:v118',
  command: ['node', 'dist/server.js'],
  args: ['--port', '3000'],
  mode: { replicated: { replicas: 2 } },
  healthcheck: { test: ['CMD', 'wget', '-qO-', 'localhost:3000/health'], intervalNs: 10e9, startPeriodNs: 15e9 },
  resources: { limits: { cpus: 0.5, memoryBytes: 512 * MIB }, reservations: { cpus: 0.25, memoryBytes: 256 * MIB } },
  restartPolicy: { condition: 'on-failure', maxAttempts: 3, delayNs: 5e9 },
  updateConfig: { parallelism: 1, order: 'start-first' },
  labels: { 'swarmy.otel': 'on' },
};

describe('draft → changes → calls', () => {
  test('a preset equal to the live value is no change', () => {
    expect(draftChanges(spec, 2, { memLimit: 512 * MIB, copies: 2 })).toEqual([]);
  });

  test('the 768M preset is one tech change and one update call', () => {
    const d = { memLimit: 768 * MIB };
    expect(draftChanges(spec, 2, d)).toEqual([{ key: 'limits.memory', from: '512M', to: '768M' }]);
    expect(toCalls('svc-api', spec, 2, d)).toEqual({
      update: { id: 'svc-api', resources: { limits: { cpus: 0.5, memoryBytes: 768 * MIB } } },
      copies: null,
    });
  });

  test('copies go to scale; knobs go to update, only the changed ones', () => {
    const calls = toCalls('svc-api', spec, 2, { copies: 3, order: 'stop-first', restart: 'on-failure' });
    expect(calls).toEqual({ update: { id: 'svc-api', updateOrder: 'stop-first' }, copies: 3 });
  });

  test('apply sentence: rolling with an honest estimate, or none', () => {
    const changes = draftChanges(spec, 2, { memLimit: 768 * MIB });
    expect(rolloutSeconds(spec, 2)).toBe(50);
    expect(applySentence(spec, 2, changes)).toBe('1 change · rolling, 1 copy at a time · ~50 s');
    const noHc = { ...spec, healthcheck: undefined };
    expect(applySentence(noHc, 2, changes)).toBe('1 change · rolling, 1 copy at a time');
    expect(applySentence(spec, 2, [{ key: 'replicas', from: '2', to: '3' }])).toContain('nothing restarts');
  });

  test('memory formats in the compose dialect', () => {
    expect(fmtMem(768 * MIB)).toBe('768M');
    expect(fmtMem(1024 * MIB)).toBe('1G');
    expect(fmtMem(1536 * MIB)).toBe('1.5G');
  });
});

describe('live compose with changed lines', () => {
  test('only the memory limit line is marked', () => {
    const base = composeOf('api', spec);
    const next = composeOf('api', applyDraft(spec, { memLimit: 768 * MIB }));
    const lines = next.split('\n');
    const marked = [...changedLines(base, next)].map((i) => lines[i]!.trim());
    expect(marked).toEqual(['memory: 768M']);
    expect(base).toContain('order: start-first');
    expect(base).toContain('delay: 5s');
  });
});
