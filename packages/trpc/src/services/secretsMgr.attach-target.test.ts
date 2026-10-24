import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { attachSecretToService, managedLabels } from './secretsMgr.service';

/**
 * An environment's own family (`stripe-key.qa`) mounts where the app reads
 * the shared name (`/run/secrets/stripe-key`) — the controller-internal
 * `target` the clone's secret slots use. A tiny swarm: one live service, one
 * family version, and the deploy payloads it receives.
 */
function swarm() {
  const deploys: ServiceSpec[] = [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async () => ({}) } },
    hub: {
      managerNode: () => 'node1',
      isOnline: () => true,
      liveInventory: () => ({
        services: [{ id: 'svc-api', name: 'shop-qa_api', image: 'api:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0, labels: { 'com.docker.stack.namespace': 'shop-qa' }, networks: [], env: [], ports: [], secrets: [], configs: [] }],
        containers: [],
      }),
      dispatch: async (_n: string, command: string, payload: Record<string, unknown>) => {
        if (command === 'secret.list')
          return { secrets: [{ id: 's1', name: 'stripe-key.qa__v1', createdAt: 1, labels: managedLabels({ activeOrgId: 'org1' } as OrgContext, 'stripe-key.qa', 1) }] };
        if (command === 'service.inspect')
          return { inspect: { ID: 'svc-api', Version: { Index: 1 }, Spec: { Name: 'shop-qa_api', Labels: {}, TaskTemplate: { ContainerSpec: { Image: 'api:1' } }, Mode: { Replicated: { Replicas: 1 } } } } };
        if (command === 'service.deploy') deploys.push(payload.spec as ServiceSpec);
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, deploys };
}

describe('attachSecretToService — mount target', () => {
  it('mounts an environment’s own family at the shared name', async () => {
    const { ctx, deploys } = swarm();
    const res = await attachSecretToService(ctx, { family: 'stripe-key.qa', service: 'shop-qa_api', target: 'stripe-key' });
    expect(deploys[0]?.secrets).toEqual([{ source: 'stripe-key.qa__v1', target: 'stripe-key' }]);
    expect(res.mountPath).toBe('/run/secrets/stripe-key');
  });

  it('without a target it keeps the family’s own path', async () => {
    const { ctx, deploys } = swarm();
    await attachSecretToService(ctx, { family: 'stripe-key.qa', service: 'shop-qa_api' });
    expect(deploys[0]?.secrets).toEqual([{ source: 'stripe-key.qa__v1', target: 'stripe-key.qa' }]);
  });
});
