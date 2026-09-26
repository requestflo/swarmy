import { describe, expect, it } from 'bun:test';
import { toServiceCreateOptions } from './docker';
import { ServiceSpec } from './protocol/commands';
import { specFromInspect } from './service-inspect';

/**
 * The settings knobs round-trip: ServiceSpec → Docker create body → inspect
 * → ServiceSpec. Resources, restart policy (with its delay) and the rolling
 * update order must survive so the settings panel reads back what it wrote.
 */
describe('service settings round-trip', () => {
  const spec = ServiceSpec.parse({
    name: 'storefront_api',
    image: 'registry.northwind.dev/storefront/api:v118',
    command: ['node', 'dist/server.js'],
    args: ['--port', '3000'],
    labels: { 'swarmy.otel': 'on' },
    resources: { limits: { cpus: 0.5, memoryBytes: 768 * 1024 ** 2 }, reservations: { cpus: 0.25, memoryBytes: 256 * 1024 ** 2 } },
    restartPolicy: { condition: 'on-failure', maxAttempts: 3, delayNs: 5e9 },
    updateConfig: { parallelism: 1, order: 'start-first' },
  });

  it('maps onto the Docker body', () => {
    const body = toServiceCreateOptions(spec) as unknown as {
      TaskTemplate: { RestartPolicy: Record<string, unknown> };
      UpdateConfig: Record<string, unknown>;
    };
    expect(body.TaskTemplate.RestartPolicy).toEqual({ Condition: 'on-failure', MaxAttempts: 3, Delay: 5e9 });
    expect(body.UpdateConfig.Order).toBe('start-first');
  });

  it('reads back the same knobs from inspect', () => {
    const back = specFromInspect({ Spec: toServiceCreateOptions(spec) }, [])!;
    expect(back.resources).toEqual(spec.resources);
    expect(back.restartPolicy).toEqual(spec.restartPolicy);
    expect(back.updateConfig).toEqual({ parallelism: 1, order: 'start-first' });
    expect(back.command).toEqual(spec.command);
    expect(back.args).toEqual(spec.args);
    expect(back.labels).toEqual(spec.labels);
  });
});
