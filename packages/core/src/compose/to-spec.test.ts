import { describe, expect, it } from 'bun:test';
import { ServiceModel } from './model';
import { modelToServiceSpec } from './to-spec';
import { validateModel } from './validate';

/**
 * Model -> wire ServiceSpec mapping for the Phase-2+ long-tail fields, plus the
 * semantic validation rules. The dockerode ServiceCreateOptions mapping
 * (placement/healthcheck/resources -> TaskTemplate) lives in @swarmy/core
 * docker.ts and is covered by the INTEGRATION snippet's test.
 */

function model(partial: Record<string, unknown>) {
  return ServiceModel.parse({ name: 'svc', image: 'nginx:1.27', ...partial });
}

describe('modelToServiceSpec — long-tail fields', () => {
  it('maps placement onto the wire spec', () => {
    const spec = modelToServiceSpec(
      model({
        placement: {
          constraints: ['node.role==worker'],
          preferences: ['spread=node.labels.zone'],
          maxReplicasPerNode: 2,
        },
      }),
    );
    expect(spec.placement).toEqual({
      constraints: ['node.role==worker'],
      preferences: ['spread=node.labels.zone'],
      maxReplicasPerNode: 2,
    });
  });

  it('maps healthcheck (ns durations) onto the wire spec', () => {
    const spec = modelToServiceSpec(
      model({
        healthcheck: {
          test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
          intervalNs: 30_000_000_000,
          timeoutNs: 5_000_000_000,
          retries: 3,
        },
      }),
    );
    expect(spec.healthcheck).toEqual({
      test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
      intervalNs: 30_000_000_000,
      timeoutNs: 5_000_000_000,
      retries: 3,
    });
  });

  it('maps resources limits + reservations', () => {
    const spec = modelToServiceSpec(
      model({
        resources: {
          limits: { cpus: 1, memoryBytes: 1_073_741_824 },
          reservations: { cpus: 0.5, memoryBytes: 268_435_456 },
        },
      }),
    );
    expect(spec.resources).toEqual({
      limits: { cpus: 1, memoryBytes: 1_073_741_824 },
      reservations: { cpus: 0.5, memoryBytes: 268_435_456 },
    });
  });

  it('strips undefined config/secret ref fields', () => {
    const spec = modelToServiceSpec(
      model({ configs: [{ source: 'cfg' }], secrets: [{ source: 'pw', target: 'pw_file' }] }),
    );
    expect(spec.configs).toEqual([{ source: 'cfg' }]);
    expect(spec.secrets).toEqual([{ source: 'pw', target: 'pw_file' }]);
  });

  it('omits sections that are empty', () => {
    const spec = modelToServiceSpec(model({}));
    expect(spec.healthcheck).toBeUndefined();
    expect(spec.resources).toBeUndefined();
    expect(spec.configs).toBeUndefined();
    expect(spec.placement).toBeUndefined();
  });
});

describe('validateModel', () => {
  it('flags missing image as a blocking warn', () => {
    // image has `.min(1)`, so an empty image can only arise from raw UI state,
    // not a parsed model — validate the raw shape directly.
    const m = { ...model({}), image: '' };
    const codes = validateModel(m).map((w) => w.code);
    expect(codes).toContain('image-required');
  });

  it('warns when healthcheck timeout exceeds interval', () => {
    const m = model({
      healthcheck: { test: ['CMD', 'true'], intervalNs: 1_000_000_000, timeoutNs: 5_000_000_000 },
    });
    const codes = validateModel(m).map((w) => w.code);
    expect(codes).toContain('healthcheck-timeout-gt-interval');
  });

  it('warns when a reservation exceeds its limit', () => {
    const m = model({
      resources: { limits: { cpus: 0.5 }, reservations: { cpus: 1 } },
    });
    const codes = validateModel(m).map((w) => w.code);
    expect(codes).toContain('reservation-gt-limit');
  });

  it('is clean for a sensible model', () => {
    const m = model({
      replicas: 2,
      ports: [{ target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' }],
    });
    const warns = validateModel(m).filter((w) => w.level === 'warn');
    expect(warns).toEqual([]);
  });
});
