import { describe, expect, it } from 'bun:test';
import { composeToModels } from './from-compose';
import { modelsToCompose } from './to-compose';
import { modelToServiceSpec } from './to-spec';

/**
 * Golden round-trip tests: compose object -> ServiceModel -> compose object,
 * asserting model-level idempotency for the common fields. Run with `bun test`.
 */

const SAMPLE = {
  services: {
    web: {
      image: 'nginx:1.27',
      command: 'nginx -g daemon off;',
      environment: ['TZ=UTC', 'DEBUG=1'],
      labels: { 'com.example.team': 'platform' },
      ports: ['8080:80/tcp', '443'],
      volumes: ['web-data:/usr/share/nginx/html:ro', '/etc/conf:/etc/nginx'],
      networks: ['frontend', 'backend'],
      deploy: {
        replicas: 3,
        restart_policy: { condition: 'on-failure', max_attempts: 5 },
        placement: {
          constraints: ['node.role==worker'],
          preferences: [{ spread: 'node.labels.zone' }],
          max_replicas_per_node: 2,
        },
      },
      // unsupported / swarm-incompatible — must be preserved
      build: { context: '.' },
      depends_on: ['db'],
    },
    db: {
      image: 'postgres:16',
      environment: { POSTGRES_PASSWORD: 'secret' },
      deploy: { mode: 'global' },
    },
  },
};

describe('compose <-> model round-trip', () => {
  it('maps common fields and re-derives idempotently', () => {
    const { models } = composeToModels(SAMPLE);
    const web = models.find((m) => m.name === 'web');
    expect(web).toBeDefined();
    if (!web) return;

    expect(web.image).toBe('nginx:1.27');
    expect(web.command).toEqual(['nginx', '-g', 'daemon', 'off;']);
    expect(web.env).toEqual({ TZ: 'UTC', DEBUG: '1' });
    expect(web.labels).toEqual({ 'com.example.team': 'platform' });
    expect(web.replicas).toBe(3);
    expect(web.mode).toBe('replicated');

    expect(web.ports).toEqual([
      { target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' },
      { target: 443, published: undefined, protocol: 'tcp', mode: 'ingress' },
    ]);
    expect(web.mounts).toEqual([
      { type: 'volume', source: 'web-data', target: '/usr/share/nginx/html', readOnly: true },
      { type: 'bind', source: '/etc/conf', target: '/etc/nginx', readOnly: false },
    ]);
    expect(web.networks).toEqual(['frontend', 'backend']);
    expect(web.restart).toEqual({ condition: 'on-failure', maxAttempts: 5 });
    expect(web.placement).toEqual({
      constraints: ['node.role==worker'],
      preferences: ['spread=node.labels.zone'],
      maxReplicasPerNode: 2,
    });

    // unsupported preserved
    expect(web.unsupported.build).toEqual({ context: '.' });
    expect(web.unsupported.depends_on).toEqual(['db']);
  });

  it('classifies global mode', () => {
    const { models } = composeToModels(SAMPLE);
    const db = models.find((m) => m.name === 'db');
    expect(db?.mode).toBe('global');
  });

  it('warns on swarm-incompatible keys', () => {
    const { warnings } = composeToModels(SAMPLE);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('swarm-incompatible');
  });

  it('compose -> model -> compose -> model is idempotent at the model level', () => {
    const first = composeToModels(SAMPLE).models;
    const reEmitted = modelsToCompose(first);
    const second = composeToModels(reEmitted).models;
    expect(second).toEqual(first);
  });

  it('preserves unsupported keys on export', () => {
    const models = composeToModels(SAMPLE).models;
    const out = modelsToCompose(models);
    expect(out.services.web?.build).toEqual({ context: '.' });
    expect(out.services.web?.depends_on).toEqual(['db']);
  });

  it('projects to a wire ServiceSpec with placement', () => {
    const web = composeToModels(SAMPLE).models.find((m) => m.name === 'web');
    if (!web) throw new Error('missing');
    const spec = modelToServiceSpec(web);
    expect(spec.mode).toEqual({ replicated: { replicas: 3 } });
    expect(spec.ports?.[0]).toEqual({ target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' });
    expect(spec.placement).toEqual({
      constraints: ['node.role==worker'],
      preferences: ['spread=node.labels.zone'],
      maxReplicasPerNode: 2,
    });
    expect(spec.restartPolicy).toEqual({ condition: 'on-failure', maxAttempts: 5 });
  });
});
