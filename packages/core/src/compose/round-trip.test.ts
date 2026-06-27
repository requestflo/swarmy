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
        resources: {
          limits: { cpus: '0.5', memory: '512M' },
          reservations: { cpus: 0.25, memory: '256M' },
        },
        placement: {
          constraints: ['node.role==worker'],
          preferences: [{ spread: 'node.labels.zone' }],
          max_replicas_per_node: 2,
        },
      },
      healthcheck: {
        test: ['CMD', 'curl', '-f', 'http://localhost/'],
        interval: '30s',
        timeout: '5s',
        retries: 3,
        start_period: '10s',
      },
      configs: ['app-config', { source: 'tls-cert', target: '/etc/tls/cert.pem', mode: 292 }],
      secrets: [{ source: 'db-password', target: 'db_password' }],
      ulimits: { nofile: { soft: 1024, hard: 4096 }, nproc: 512 },
      logging: { driver: 'json-file', options: { 'max-size': '10m' } },
      stop_grace_period: '30s',
      depends_on: ['db'],
      // unsupported / swarm-incompatible — must be preserved
      build: { context: '.' },
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
    // depends_on is now mapped (captured), not dropped into unsupported.
    expect(web.unsupported.depends_on).toBeUndefined();
    expect(web.dependsOn).toEqual(['db']);
  });

  it('maps healthcheck, resources, configs/secrets, ulimits, logging', () => {
    const web = composeToModels(SAMPLE).models.find((m) => m.name === 'web');
    if (!web) throw new Error('missing');

    expect(web.healthcheck).toEqual({
      test: ['CMD', 'curl', '-f', 'http://localhost/'],
      intervalNs: 30_000_000_000,
      timeoutNs: 5_000_000_000,
      startPeriodNs: 10_000_000_000,
      retries: 3,
      disable: undefined,
    });
    expect(web.resources).toEqual({
      limits: { cpus: 0.5, memoryBytes: 512_000_000 },
      reservations: { cpus: 0.25, memoryBytes: 256_000_000 },
    });
    expect(web.configs).toEqual([
      { source: 'app-config', target: undefined, uid: undefined, gid: undefined, mode: undefined },
      { source: 'tls-cert', target: '/etc/tls/cert.pem', uid: undefined, gid: undefined, mode: 292 },
    ]);
    expect(web.secrets).toEqual([
      { source: 'db-password', target: 'db_password', uid: undefined, gid: undefined, mode: undefined },
    ]);
    expect(web.ulimits).toEqual([
      { name: 'nofile', soft: 1024, hard: 4096 },
      { name: 'nproc', soft: 512, hard: 512 },
    ]);
    expect(web.logging).toEqual({ driver: 'json-file', options: { 'max-size': '10m' } });
    expect(web.stopGracePeriodNs).toBe(30_000_000_000);
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
    expect(spec.healthcheck).toEqual({
      test: ['CMD', 'curl', '-f', 'http://localhost/'],
      intervalNs: 30_000_000_000,
      timeoutNs: 5_000_000_000,
      startPeriodNs: 10_000_000_000,
      retries: 3,
    });
    expect(spec.resources).toEqual({
      limits: { cpus: 0.5, memoryBytes: 512_000_000 },
      reservations: { cpus: 0.25, memoryBytes: 256_000_000 },
    });
    expect(spec.configs).toEqual([
      { source: 'app-config' },
      { source: 'tls-cert', target: '/etc/tls/cert.pem', mode: 292 },
    ]);
    expect(spec.secrets).toEqual([{ source: 'db-password', target: 'db_password' }]);
    expect(spec.stopGracePeriodNs).toBe(30_000_000_000);
  });
});
