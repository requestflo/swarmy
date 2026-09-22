import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { applyStorageNode } from './storage';

const rendered = {
  driver: 'garage' as const,
  files: [],
  configs: [{ source: 'swarmy-garage-config-abcd1234', target: '/etc/garage.toml', mode: 0o400 }],
  placement: { constraints: ['node.labels.swarmy.garage.member==true'] },
  serviceMode: 'global' as const,
  serviceName: 'swarmy-garage',
  image: 'dxflrs/garage:v1.0.1',
  s3Port: 3900,
  adminPort: 3903,
  summary: '',
};

function fakeDocker(existing?: { global: boolean; labels?: Record<string, string> }) {
  const calls: { created?: ServiceSpec; updated?: Record<string, unknown>; removed: boolean } = { removed: false };
  const svc = existing && {
    inspect: async () => ({
      ID: 'svc1',
      Version: { Index: 7 },
      Spec: { Mode: existing.global ? { Global: {} } : { Replicated: { Replicas: 1 } }, Labels: existing.labels },
    }),
    update: async (o: Record<string, unknown>) => {
      calls.updated = o;
    },
    remove: async () => {
      calls.removed = true;
    },
  };
  const docker = {
    getServiceByName: async () => svc ?? null,
    createService: async (spec: ServiceSpec) => {
      calls.created = spec;
      return 'new1';
    },
    prepareServiceOptions: async (spec: ServiceSpec) => ({ Name: spec.name, Labels: spec.labels }),
  } as unknown as DockerClient;
  return { docker, calls };
}

describe('applyStorageNode — Docker configs, no host files', () => {
  it('creates a global, member-pinned service mounting the config (no bind)', async () => {
    const { docker, calls } = fakeDocker();
    await applyStorageNode(docker, { commandId: 'c1', rendered });
    const spec = calls.created!;
    expect(spec.mode).toEqual({ global: {} });
    expect(spec.configs).toEqual(rendered.configs);
    expect(spec.placement).toEqual({ constraints: rendered.placement.constraints });
    expect(spec.mounts?.some((m) => m.type === 'bind')).toBe(false);
  });

  it('recreates a legacy replicated service (mode cannot change in place)', async () => {
    const { docker, calls } = fakeDocker({ global: false });
    const res = await applyStorageNode(docker, { commandId: 'c1', rendered });
    expect(calls.removed).toBe(true);
    expect(calls.created?.mode).toEqual({ global: {} });
    expect(res.serviceId).toBe('new1');
  });

  it('updates an existing global service in place, keeping foreign labels', async () => {
    const { docker, calls } = fakeDocker({ global: true, labels: { 'swarmy.storage.stats': '{}' } });
    await applyStorageNode(docker, { commandId: 'c1', rendered });
    expect(calls.removed).toBe(false);
    expect(calls.updated?.version).toBe(7);
    expect((calls.updated?.Labels as Record<string, string>)['swarmy.storage.stats']).toBe('{}');
    expect((calls.updated?.Labels as Record<string, string>)['swarmy.managed']).toBe('true');
  });
});

describe('applyStorageNode — Docker secrets (rpc secret / admin token)', () => {
  const secrets = [
    { source: 'swarmy-garage-rpc-secret-11111111', target: 'garage-rpc-secret', mode: 0o400 },
    { source: 'swarmy-garage-admin-token-22222222', target: 'garage-admin-token', mode: 0o400 },
  ];
  it('attaches the rendered secrets to the store service spec', async () => {
    const { docker, calls } = fakeDocker();
    await applyStorageNode(docker, { commandId: 'c1', rendered: { ...rendered, secrets } });
    expect(calls.created?.secrets).toEqual(secrets);
  });
  it('no secrets in the render ⇒ none on the spec (legacy renders unchanged)', async () => {
    const { docker, calls } = fakeDocker();
    await applyStorageNode(docker, { commandId: 'c1', rendered });
    expect(calls.created?.secrets).toBeUndefined();
  });
});

describe('applyStorageNode — overlay-only (networks set)', () => {
  it('joins the overlay and publishes NO ports', async () => {
    const { docker, calls } = fakeDocker();
    await applyStorageNode(docker, { commandId: 'c1', rendered: { ...rendered, networks: ['swarmy'] } });
    expect(calls.created?.networks).toEqual(['swarmy']);
    expect(calls.created?.ports).toEqual([]);
  });

  it('an update strips legacy published ports (ports: [] is sent, not omitted)', async () => {
    const { docker, calls } = fakeDocker({ global: true });
    const seen: ServiceSpec[] = [];
    (docker as unknown as { prepareServiceOptions: (s: ServiceSpec) => Promise<unknown> }).prepareServiceOptions =
      async (s: ServiceSpec) => {
        seen.push(s);
        return { Name: s.name };
      };
    await applyStorageNode(docker, { commandId: 'c1', rendered: { ...rendered, networks: ['swarmy'] } });
    expect(calls.updated).toBeDefined();
    expect(seen[0]?.ports).toEqual([]);
    expect(seen[0]?.networks).toEqual(['swarmy']);
  });

  it('legacy render (no networks) keeps the routing-mesh ports', async () => {
    const { docker, calls } = fakeDocker();
    await applyStorageNode(docker, { commandId: 'c1', rendered });
    expect(calls.created?.ports?.map((p) => p.target)).toEqual([3900, 3903]);
    expect(calls.created?.networks).toBeUndefined();
  });
});
