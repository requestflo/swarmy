import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { siblingSpecFrom } from './region.service';

/** The parent's FULL live spec, as `liveServiceSpec` (service.inspect) yields it. */
const live: ServiceSpec = {
  name: 'shop_web',
  image: 'ghcr.io/acme/web:1.0.0',
  mode: { replicated: { replicas: 0 } },
  env: { NODE_ENV: 'production' },
  command: ['node'],
  args: ['server.js', '--port', '3000'],
  labels: {
    'com.docker.stack.namespace': 'shop',
    'swarmy.region.us-east.replicas': '2',
    'swarmy.region.eu-west.replicas': '1',
    'swarmy.ingress.routes': '[{"host":"shop.example.com","port":3000}]',
    'swarmy.scaleToZero.enabled': 'true',
  },
  mounts: [
    { type: 'volume', source: 'shop_uploads', target: '/app/uploads' },
    { type: 'tmpfs', target: '/tmp' },
  ],
  secrets: [{ source: 'shop-db-password', target: 'db-password', mode: 292 }],
  configs: [{ source: 'shop-app-config', target: '/app/config.json' }],
  ports: [{ target: 3000, published: 8080, protocol: 'tcp', mode: 'ingress' }],
  networks: ['shop_default'],
  healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'], retries: 3 },
  resources: { limits: { cpus: 0.5, memoryBytes: 268_435_456 }, reservations: { memoryBytes: 134_217_728 } },
  restartPolicy: { condition: 'on-failure', maxAttempts: 5 },
  placement: {
    constraints: ['node.role == worker', 'node.labels.swarmy.region==us-east', 'node.hostname == box-1'],
    preferences: ['spread=node.labels.zone'],
    maxReplicasPerNode: 2,
  },
  stopGracePeriodNs: 10_000_000_000,
};
const parent = { name: 'shop_web', labels: live.labels! };

describe('siblingSpecFrom — region sibling cut from the FULL live spec', () => {
  it('golden: keeps command/args, healthcheck, resources, mounts, secrets/configs, restart, networks', () => {
    const s = siblingSpecFrom(live, parent, 'eu-west', 3);
    expect(s.image).toBe('ghcr.io/acme/web:1.0.0');
    expect(s.command).toEqual(['node']);
    expect(s.args).toEqual(['server.js', '--port', '3000']);
    expect(s.env).toEqual({ NODE_ENV: 'production' });
    expect(s.healthcheck).toEqual(live.healthcheck);
    expect(s.resources).toEqual(live.resources);
    // Named volumes kept (node-local: a fresh per-node volume, not shared data).
    expect(s.mounts).toEqual(live.mounts);
    expect(s.secrets).toEqual(live.secrets);
    expect(s.configs).toEqual(live.configs);
    expect(s.restartPolicy).toEqual(live.restartPolicy);
    expect(s.stopGracePeriodNs).toBe(10_000_000_000);
    expect(s.networks).toEqual(['shop_default']);
  });

  it('swaps name + replicas, drops published ports', () => {
    const s = siblingSpecFrom(live, parent, 'eu-west', 3);
    expect(s.name).toBe('shop_web-eu-west');
    expect(s.mode).toEqual({ replicated: { replicas: 3 } });
    expect(s.ports).toBeUndefined();
  });

  it('pins to the region, dropping inherited region/host pins but keeping other placement', () => {
    const s = siblingSpecFrom(live, parent, 'eu-west', 1);
    expect(s.placement).toEqual({
      constraints: ['node.role == worker', 'node.labels.swarmy.region==eu-west'],
      preferences: ['spread=node.labels.zone'],
      maxReplicasPerNode: 2,
    });
  });

  it('clean label set: markers + stack only — never the parent declarations, routes or scale-to-zero', () => {
    const s = siblingSpecFrom(live, parent, 'eu-west', 1);
    expect(s.labels).toEqual({
      'swarmy.managed': 'true',
      'swarmy.region.parent': 'shop_web',
      'swarmy.region.of': 'eu-west',
      'com.docker.stack.namespace': 'shop',
    });
  });

  it('does not mutate the live spec', () => {
    const before = JSON.stringify(live);
    siblingSpecFrom(live, parent, 'us-east', 2);
    expect(JSON.stringify(live)).toBe(before);
  });
});
