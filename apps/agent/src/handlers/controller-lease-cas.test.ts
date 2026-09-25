import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { CONTROLLER_LEASE_LABEL } from '@swarmy/core/protocol';
import { applyControllerService } from './controller-service';

/** QA-022: a renew that loses the CAS race while the lease is STILL OURS is a conflict, not a loss. */
function swarm(lease: Record<string, unknown>, bumpBeforeUpdate: boolean) {
  const state = { index: 10, spec: { Name: 'swarmy_controller', Labels: { 'swarmy.system': 'true', [CONTROLLER_LEASE_LABEL]: JSON.stringify(lease) } } as Record<string, any> };
  let bump = bumpBeforeUpdate;
  const svc = {
    inspect: async () => ({ Version: { Index: state.index }, Spec: structuredClone(state.spec) }),
    update: async (body: { version: number }) => {
      if (bump) {
        bump = false;
        state.index++; // an unrelated spec write (another label) landed first
      }
      if (body.version !== state.index) throw new Error('rpc error: code = Unknown desc = update out of sequence');
      state.index++;
    },
  };
  return { getServiceByName: async () => svc } as unknown as DockerClient;
}

const ours = { holder: 'task-a', node: 'node-a', hostname: 'mgr-1', epoch: 6, renewedAt: 1, ttlMs: 60_000 };
const renew = { kind: 'lease.renew', holder: 'task-a', node: 'node-a', ttlMs: 60_000, epoch: 6 } as const;

describe('lease renew CAS race', () => {
  it('still ours after the race → conflict (the holder retries, never fences on its own epoch)', async () => {
    const r = await applyControllerService(swarm(ours, true), { commandId: 'c', service: 'swarmy_controller', op: renew });
    expect(r).toMatchObject({ ok: false, reason: 'conflict', lease: { holder: 'task-a', epoch: 6 } });
  });
  it('without a race the renew lands', async () => {
    const r = await applyControllerService(swarm(ours, false), { commandId: 'c', service: 'swarmy_controller', op: renew });
    expect(r).toMatchObject({ ok: true, lease: { holder: 'task-a', epoch: 6 } });
  });
});
