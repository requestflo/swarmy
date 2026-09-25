import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { resolveExecTarget } from './live-resolve';

/** Mid-rollout after a secret rotation: an old-spec task and a new-spec task both run. */
function ctxWith() {
  const containers = {
    n1: [{ id: 'old', serviceId: 'svc1', state: 'running', createdAt: 1_000, labels: {} }],
    n2: [{ id: 'new', serviceId: 'svc1', state: 'running', createdAt: 5_000, labels: {} }],
  } as Record<string, unknown[]>;
  return {
    activeOrgId: 'org1',
    hub: {
      liveInventory: () => ({
        services: [{ id: 'svc1', name: 'shop_api', labels: {}, networks: [], env: [], ports: [], runningReplicas: 2, desiredReplicas: 1, mode: 'replicated', image: 'x', createdAt: 0, updatedAt: 0 }],
        containers: [...containers.n1!, ...containers.n2!],
      }),
      onlineNodeIds: () => ['n1', 'n2'],
      latestContainers: (n: string) => containers[n] ?? [],
    },
  } as unknown as OrgContext;
}

describe('resolveExecTarget newest (revealSecretVar after rotation)', () => {
  it('prefers the most recently created running task (the newest spec version)', () => {
    expect(resolveExecTarget(ctxWith(), 'svc1', { newest: true })).toMatchObject({ containerId: 'new', nodeId: 'n2' });
  });
  it('default keeps the first-found behaviour (terminal exec)', () => {
    expect(resolveExecTarget(ctxWith(), 'svc1')).toMatchObject({ containerId: 'old' });
  });
});
