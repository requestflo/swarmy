import { describe, expect, it } from 'bun:test';
import type { InvService } from '@swarmy/core';
import {
  CANARY_OF_LABEL,
  CANARY_PARAMS_LABEL,
  canaryNameFor,
  canarySpecFor,
  parseCanaryParams,
  promoteSpecFrom,
  routesWithCanary,
  routesWithoutCanary,
  type CanaryParams,
} from './releases.service';
import type { Route } from './ingress-routes';

// ── params label codec ────────────────────────────────────────────────────────

const params: CanaryParams = {
  trafficPct: 10,
  durationMin: 15,
  rollbackOnErrorRatePct: 5,
  stableImage: 'ghcr.io/acme/web:1.0.0',
  startedAt: '2026-07-02T09:00:00.000Z',
};

describe('parseCanaryParams', () => {
  it('round-trips a params payload', () => {
    expect(parseCanaryParams(JSON.stringify(params))).toEqual(params);
  });

  it('null rollback threshold survives (auto-rollback disabled)', () => {
    const p = parseCanaryParams(JSON.stringify({ ...params, rollbackOnErrorRatePct: null }));
    expect(p?.rollbackOnErrorRatePct).toBeNull();
  });

  it('rejects garbage: missing label, bad JSON, bad numbers, bad date', () => {
    expect(parseCanaryParams(undefined)).toBeNull();
    expect(parseCanaryParams('')).toBeNull();
    expect(parseCanaryParams('{nope')).toBeNull();
    expect(parseCanaryParams(JSON.stringify({ ...params, trafficPct: 0 }))).toBeNull();
    expect(parseCanaryParams(JSON.stringify({ ...params, trafficPct: 101 }))).toBeNull();
    expect(parseCanaryParams(JSON.stringify({ ...params, durationMin: -1 }))).toBeNull();
    expect(parseCanaryParams(JSON.stringify({ ...params, startedAt: 'yesterday-ish' }))).toBeNull();
  });
});

// ── route stamping ────────────────────────────────────────────────────────────

describe('routesWithCanary / routesWithoutCanary', () => {
  const routes: Route[] = [
    { host: 'app.example.com', port: 3000, tls: 'auto' },
    { host: 'api.example.com', port: 8080, tls: 'auto', path: '/api', stripPrefix: true },
  ];

  it('stamps a weighted canary upstream on every route, per-route port', () => {
    const stamped = routesWithCanary(routes, 'web--canary', 10);
    expect(stamped).toHaveLength(2);
    expect(stamped[0]?.canary).toEqual({ service: 'web--canary', port: 3000, weightPct: 10 });
    expect(stamped[1]?.canary).toEqual({ service: 'web--canary', port: 8080, weightPct: 10 });
    // Original route fields survive untouched.
    expect(stamped[1]?.path).toBe('/api');
    expect(stamped[1]?.stripPrefix).toBe(true);
  });

  it('clamps + rounds the weight', () => {
    expect(routesWithCanary(routes, 'c', 250)[0]?.canary?.weightPct).toBe(100);
    expect(routesWithCanary(routes, 'c', -3)[0]?.canary?.weightPct).toBe(0);
    expect(routesWithCanary(routes, 'c', 33.4)[0]?.canary?.weightPct).toBe(33);
  });

  it('strip is a clean inverse (no canary key left behind)', () => {
    const stripped = routesWithoutCanary(routesWithCanary(routes, 'web--canary', 10));
    expect(stripped).toEqual(routes);
    expect(Object.keys(stripped[0] ?? {})).not.toContain('canary');
  });
});

// ── canary spec builder ───────────────────────────────────────────────────────

function inv(partial: Partial<InvService>): InvService {
  return {
    id: 'svc1',
    name: 'shop_web',
    image: 'ghcr.io/acme/web:1.0.0',
    stack: 'shop',
    mode: 'replicated',
    replicas: { desired: 3, running: 3 },
    status: 'running',
    scaleToZero: false,
    labels: {},
    networks: [{ name: 'shop_default', aliases: [] }],
    env: ['NODE_ENV=production', 'PORT=3000'],
    ports: [{ target: 3000, protocol: 'tcp' }],
    secrets: ['shop-db-password'],
    configs: [],
    containers: [],
    ...partial,
  };
}

describe('canarySpecFor', () => {
  it('same runtime surface, candidate image, 1 replica, canary labels, no ports', () => {
    const spec = canarySpecFor(inv({}), 'ghcr.io/acme/web:1.1.0-rc.1', params);
    expect(spec.name).toBe('shop_web--canary');
    expect(canaryNameFor('shop_web')).toBe('shop_web--canary');
    expect(spec.image).toBe('ghcr.io/acme/web:1.1.0-rc.1');
    expect(spec.mode).toEqual({ replicated: { replicas: 1 } });
    expect(spec.env).toEqual({ NODE_ENV: 'production', PORT: '3000' });
    expect(spec.networks).toEqual(['shop_default']);
    expect(spec.secrets).toEqual([{ source: 'shop-db-password' }]);
    expect(spec.ports).toBeUndefined(); // traffic arrives only via the weighted route
    expect(spec.labels?.[CANARY_OF_LABEL]).toBe('shop_web');
    expect(spec.labels?.['com.docker.stack.namespace']).toBe('shop');
    expect(parseCanaryParams(spec.labels?.[CANARY_PARAMS_LABEL])).toEqual(params);
  });

  it('an ungrouped service gets no stack namespace label', () => {
    const spec = canarySpecFor(inv({ stack: '(ungrouped)', name: 'web' }), 'img:2', params);
    expect(spec.labels?.['com.docker.stack.namespace']).toBeUndefined();
    expect(spec.name).toBe('web--canary');
  });
});

// ── promote spec (raw docker inspect → full ServiceSpec with the new image) ──

const rawInspect = {
  ID: 'aaaa',
  Version: { Index: 42 },
  Spec: {
    Name: 'shop_web',
    Labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': '[]' },
    TaskTemplate: {
      ContainerSpec: {
        Image: 'ghcr.io/acme/web:1.0.0@sha256:aa',
        Env: ['NODE_ENV=production', 'PORT=3000'],
        Args: ['--serve'],
        Mounts: [{ Type: 'volume', Source: 'web-data', Target: '/data', ReadOnly: false }],
        Secrets: [
          { SecretName: 'shop-db-password', File: { Name: 'db-password', UID: '0', GID: '0', Mode: 292 } },
        ],
        Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'], Retries: 3 },
        StopGracePeriod: 10_000_000_000,
      },
      RestartPolicy: { Condition: 'on-failure', MaxAttempts: 5 },
      Resources: { Limits: { NanoCPUs: 500_000_000, MemoryBytes: 268_435_456 } },
      Placement: { Constraints: ['node.role == worker'] },
      Networks: [{ Target: 'q1w2e3-network-id' }],
    },
    Mode: { Replicated: { Replicas: 3 } },
    EndpointSpec: { Ports: [{ TargetPort: 3000, PublishedPort: 8080, Protocol: 'tcp', PublishMode: 'ingress' }] },
  },
};

describe('promoteSpecFrom', () => {
  it('rebuilds the FULL spec with the canary image (nothing silently stripped)', () => {
    const spec = promoteSpecFrom(rawInspect, 'ghcr.io/acme/web:1.1.0-rc.1', ['shop_default']);
    expect(spec).not.toBeNull();
    expect(spec?.name).toBe('shop_web');
    expect(spec?.image).toBe('ghcr.io/acme/web:1.1.0-rc.1');
    expect(spec?.mode).toEqual({ replicated: { replicas: 3 } });
    expect(spec?.env).toEqual({ NODE_ENV: 'production', PORT: '3000' });
    expect(spec?.args).toEqual(['--serve']);
    expect(spec?.labels?.['com.docker.stack.namespace']).toBe('shop');
    expect(spec?.mounts).toEqual([{ type: 'volume', source: 'web-data', target: '/data' }]);
    expect(spec?.secrets).toEqual([
      { source: 'shop-db-password', target: 'db-password', uid: '0', gid: '0', mode: 292 },
    ]);
    expect(spec?.ports).toEqual([{ target: 3000, published: 8080, protocol: 'tcp', mode: 'ingress' }]);
    expect(spec?.restartPolicy).toEqual({ condition: 'on-failure', maxAttempts: 5 });
    expect(spec?.placement).toEqual({ constraints: ['node.role == worker'] });
    expect(spec?.resources).toEqual({ limits: { cpus: 0.5, memoryBytes: 268_435_456 } });
    expect(spec?.healthcheck?.test).toEqual(['CMD', 'curl', '-f', 'http://localhost:3000/health']);
    expect(spec?.stopGracePeriodNs).toBe(10_000_000_000);
    // Network NAMES come from the live inventory, not the raw inspect ids.
    expect(spec?.networks).toEqual(['shop_default']);
  });

  it('global-mode services keep global mode', () => {
    const raw = { Spec: { ...rawInspect.Spec, Mode: { Global: {} } } };
    expect(promoteSpecFrom(raw, 'img:2', [])?.mode).toEqual({ global: {} });
  });

  it('unusable payloads return null instead of a destructive partial spec', () => {
    expect(promoteSpecFrom(null, 'img', [])).toBeNull();
    expect(promoteSpecFrom({}, 'img', [])).toBeNull();
    expect(promoteSpecFrom({ Spec: { TaskTemplate: {} } }, 'img', [])).toBeNull(); // no Name
  });
});
