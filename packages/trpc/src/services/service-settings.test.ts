import { describe, expect, test } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { applyServiceSettings, labelEdits } from './service-settings';

const live: ServiceSpec = {
  name: 'storefront_api',
  image: 'registry.northwind.dev/storefront/api:v118',
  command: ['node', 'dist/server.js'],
  mounts: [{ type: 'volume', source: 'api-cache', target: '/cache' }],
  resources: { limits: { cpus: 0.5, memoryBytes: 512 * 1024 ** 2 }, reservations: { cpus: 0.25 } },
  restartPolicy: { condition: 'on-failure', maxAttempts: 3, delayNs: 5e9 },
  updateConfig: { parallelism: 1, order: 'start-first', failureAction: 'rollback' },
};

describe('applyServiceSettings', () => {
  test('nothing named → spec carried verbatim', () => {
    expect(applyServiceSettings(live, {})).toEqual(live);
  });

  test('a resource side replaces only that side', () => {
    const out = applyServiceSettings(live, { resources: { limits: { cpus: 0.5, memoryBytes: 768 * 1024 ** 2 } } });
    expect(out.resources).toEqual({
      limits: { cpus: 0.5, memoryBytes: 768 * 1024 ** 2 },
      reservations: { cpus: 0.25 },
    });
    expect(out.mounts).toEqual(live.mounts);
    expect(out.command).toEqual(live.command);
  });

  test('null clears a side; clearing both drops resources', () => {
    expect(applyServiceSettings(live, { resources: { limits: null } }).resources).toEqual({ reservations: { cpus: 0.25 } });
    expect(applyServiceSettings(live, { resources: { limits: null, reservations: null } }).resources).toBeUndefined();
  });

  test('restart policy merges over the live one; delay is seconds → ns', () => {
    const out = applyServiceSettings(live, { restartPolicy: { condition: 'any', delaySeconds: 10 } });
    expect(out.restartPolicy).toEqual({ condition: 'any', maxAttempts: 3, delayNs: 10e9 });
  });

  test('"never" drops attempts and delay', () => {
    expect(applyServiceSettings(live, { restartPolicy: { condition: 'none' } }).restartPolicy).toEqual({ condition: 'none' });
  });

  test('update order keeps the rest of the rolling policy', () => {
    expect(applyServiceSettings(live, { updateOrder: 'stop-first' }).updateConfig).toEqual({
      parallelism: 1,
      order: 'stop-first',
      failureAction: 'rollback',
    });
    expect(applyServiceSettings({ name: 'x', image: 'y' }, { updateOrder: 'start-first' }).updateConfig).toEqual({
      order: 'start-first',
    });
  });
});

describe('labelEdits', () => {
  test('protected labels are never removed', () => {
    expect(labelEdits({ removeLabels: ['swarmy.managed', 'team', 'com.docker.stack.namespace'] })).toEqual({
      setLabels: {},
      removeLabels: ['team'],
    });
  });
});
