import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { REGISTRY_FORWARDER_SPEC_LABEL } from '@swarmy/core/registry-forwarder';
import {
  forwarderAction,
  forwarderCreateOptions,
  forwarderStartResult,
  registryForwarderFact,
  superviseRegistryForwarder,
} from './registry-forwarder';

const want = forwarderCreateOptions('caddy:2-alpine@sha256:abc');
const hash = want.Labels[REGISTRY_FORWARDER_SPEC_LABEL]!;

describe('forwarderCreateOptions', () => {
  it('stamps a stable spec hash and a bounded log driver', () => {
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(forwarderCreateOptions('caddy:2-alpine@sha256:abc').Labels[REGISTRY_FORWARDER_SPEC_LABEL]).toBe(hash);
    expect(forwarderCreateOptions('caddy:2-alpine@sha256:def').Labels[REGISTRY_FORWARDER_SPEC_LABEL]).not.toBe(hash);
    expect(want.HostConfig.LogConfig.Type).toBe('json-file');
  });
});

describe('forwarderAction', () => {
  it('creates, re-creates on any spec change, restarts a stopped one, else leaves it', () => {
    expect(forwarderAction(null, hash)).toBe('create');
    expect(forwarderAction({ Config: { Labels: { [REGISTRY_FORWARDER_SPEC_LABEL]: 'old' } }, State: { Running: true } }, hash)).toBe('recreate');
    expect(forwarderAction({ Config: { Labels: { [REGISTRY_FORWARDER_SPEC_LABEL]: hash } }, State: { Running: false } }, hash)).toBe('start');
    expect(forwarderAction({ Config: { Labels: { [REGISTRY_FORWARDER_SPEC_LABEL]: hash } }, State: { Running: true } }, hash)).toBe('none');
  });
});

describe('forwarderStartResult', () => {
  it('a port the routing mesh still holds is waiting, not failed', () => {
    expect(forwarderStartResult('Bind for 127.0.0.1:5000 failed: port is already allocated').status).toBe('waiting');
    expect(forwarderStartResult('network swarmy not found').status).toBe('waiting');
    expect(forwarderStartResult('network swarmy not manually attachable').status).toBe('failed');
  });
});

/** In-memory dockerd: one container slot, a port the mesh may hold. */
function fakeDocker(opts: { swarm?: string; portHeld?: boolean; existing?: Record<string, unknown> | null } = {}) {
  const calls: string[] = [];
  let container: Record<string, unknown> | null = opts.existing ?? null;
  const d = {
    getContainer: () => ({
      inspect: async () => {
        if (!container) throw new Error('no such container');
        return container;
      },
      remove: async () => {
        calls.push('remove');
        container = null;
      },
      start: async () => {
        calls.push('start');
        if (opts.portHeld) throw new Error('Bind for 127.0.0.1:5000 failed: port is already allocated');
        container = { ...container, State: { Running: true } };
      },
    }),
    createContainer: async (o: { Labels: Record<string, string> }) => {
      calls.push('create');
      container = { Config: { Labels: o.Labels }, State: { Running: false } };
    },
    getImage: () => ({ inspect: async () => ({}) }),
    getNetwork: () => ({ inspect: async () => ({ Options: { encrypted: '' } }) }),
  };
  const docker = { docker: d, swarmState: async () => opts.swarm ?? 'active', pullImage: async () => '' } as unknown as DockerClient;
  return { docker, calls };
}

describe('superviseRegistryForwarder', () => {
  it('creates and starts it, and reports the overlay encrypted', async () => {
    const f = fakeDocker();
    expect(await superviseRegistryForwarder(f.docker, { enabled: true, image: 'caddy:2-alpine@sha256:abc' })).toEqual({ status: 'started', encrypted: true });
    expect(f.calls).toEqual(['create', 'start']);
  });

  it('steady state does nothing', async () => {
    const f = fakeDocker({ existing: { Config: { Labels: want.Labels }, State: { Running: true } } });
    expect((await superviseRegistryForwarder(f.docker, { enabled: true, image: 'caddy:2-alpine@sha256:abc' })).status).toBe('running');
    expect(f.calls).toEqual([]);
  });

  it('waits while the routing mesh holds the port, then starts the same container', async () => {
    const f = fakeDocker({ portHeld: true });
    expect((await superviseRegistryForwarder(f.docker, { enabled: true, image: 'caddy:2-alpine@sha256:abc' })).status).toBe('waiting');
    expect(f.calls).toEqual(['create', 'start']);
  });

  it('skips off-swarm, and an opt-out removes it', async () => {
    expect((await superviseRegistryForwarder(fakeDocker({ swarm: 'inactive' }).docker, { enabled: true })).status).toBe('skipped');
    const f = fakeDocker({ existing: { Config: { Labels: want.Labels }, State: { Running: true } } });
    expect((await superviseRegistryForwarder(f.docker, { enabled: false })).status).toBe('removed');
    expect(f.calls).toEqual(['remove']);
    expect(registryForwarderFact(true)).toBe('on');
    expect(registryForwarderFact(false)).toBe('off');
  });
});
