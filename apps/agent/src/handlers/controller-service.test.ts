import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { CONTROLLER_AVOID_CONSTRAINT, CONTROLLER_LEASE_LABEL, parseLeaseLabel } from '@swarmy/core/protocol';
import { applyControllerService, isOutOfSequence, nextConstraints, nextSecrets } from './controller-service';

/** A one-service fake swarm with Docker's version-index semantics. */
function fakeSwarm(labels: Record<string, string> = { 'swarmy.system': 'true' }) {
  const state = {
    index: 10,
    spec: { Name: 'swarmy_controller', Labels: { ...labels }, TaskTemplate: { Placement: { Constraints: ['node.hostname == mgr-1'] } } } as Record<string, any>,
    updates: 0,
    beforeUpdate: null as null | (() => void),
  };
  const svc = {
    inspect: async () => ({ Version: { Index: state.index }, Spec: structuredClone(state.spec) }),
    update: async (body: { version: number } & Record<string, unknown>) => {
      state.beforeUpdate?.();
      if (body.version !== state.index) throw new Error('rpc error: code = Unknown desc = update out of sequence');
      const { version: _v, ...spec } = body;
      state.spec = spec;
      state.index++;
      state.updates++;
    },
  };
  const docker = { getServiceByName: async (n: string) => (n === 'swarmy_controller' ? svc : null) } as unknown as DockerClient;
  return { state, docker };
}

const acquire = { kind: 'lease.acquire', holder: 'task-a', node: 'node-a', ttlMs: 30_000, minEpoch: 0 } as const;

describe('controllerService lease ops', () => {
  it('acquire writes the label with a version-checked update', async () => {
    const { state, docker } = fakeSwarm();
    const r = await applyControllerService(docker, { commandId: 'c', service: 'swarmy_controller', op: acquire }, () => 7);
    expect(r.ok).toBe(true);
    expect(parseLeaseLabel(state.spec.Labels[CONTROLLER_LEASE_LABEL])).toMatchObject({ holder: 'task-a', epoch: 1, renewedAt: 7 });
    // Only Spec.Labels changed: the task template (and so the task) is untouched.
    expect(state.spec.TaskTemplate).toEqual({ Placement: { Constraints: ['node.hostname == mgr-1'] } });
  });

  it('a concurrent writer makes the CAS fail (conflict), never a double win', async () => {
    const { state, docker } = fakeSwarm();
    state.beforeUpdate = () => {
      state.beforeUpdate = null;
      state.index++; // someone else updated between our inspect and update
    };
    const r = await applyControllerService(docker, { commandId: 'c', service: 'swarmy_controller', op: acquire });
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(state.updates).toBe(0);
  });

  it('renew after being superseded reports lost and writes nothing', async () => {
    const { state, docker } = fakeSwarm({
      'swarmy.system': 'true',
      [CONTROLLER_LEASE_LABEL]: JSON.stringify({ holder: 'task-b', node: 'node-b', epoch: 6, renewedAt: 1, ttlMs: 30_000 }),
    });
    const r = await applyControllerService(docker, {
      commandId: 'c',
      service: 'swarmy_controller',
      op: { kind: 'lease.renew', holder: 'task-a', node: 'node-a', ttlMs: 30_000, epoch: 5 },
    });
    expect(r).toMatchObject({ ok: false, reason: 'lost' });
    expect(state.updates).toBe(0);
  });

  it('refuses a service that is not a swarmy system service', async () => {
    const { docker } = fakeSwarm({});
    expect(await applyControllerService(docker, { commandId: 'c', service: 'swarmy_controller', op: acquire })).toMatchObject({
      ok: false,
      reason: 'not-system',
    });
  });
});

describe('placement + secret helpers', () => {
  it('floating replaces the pin, always adds the avoid constraint, keeps the rest', () => {
    expect(nextConstraints(['node.hostname == mgr-1', 'node.platform.os == linux'], 'floating')).toEqual([
      'node.role == manager',
      CONTROLLER_AVOID_CONSTRAINT,
      'node.platform.os == linux',
    ]);
    expect(nextConstraints(['node.role==manager', CONTROLLER_AVOID_CONSTRAINT], 'pinned', 'mgr-2')).toEqual([
      'node.hostname == mgr-2',
      CONTROLLER_AVOID_CONSTRAINT,
    ]);
  });

  it('swaps only the control_store secret', () => {
    const out = nextSecrets(
      [
        { SecretName: 'swarmy_secret_key', File: { Name: 'swarmy_secret_key' } },
        { SecretName: 'swarmy_control_store.1', File: { Name: 'control_store' } },
      ],
      'id2',
      'swarmy_control_store.2',
    );
    expect(out.map((s) => s.SecretName)).toEqual(['swarmy_secret_key', 'swarmy_control_store.2']);
  });

  it('recognises Docker’s stale-index error', () => {
    expect(isOutOfSequence(new Error('update out of sequence'))).toBe(true);
    expect(isOutOfSequence(new Error('no such service'))).toBe(false);
  });
});
