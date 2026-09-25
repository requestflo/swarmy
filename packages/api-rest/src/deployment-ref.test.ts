import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from './app';
import { deploymentRefToDto } from './mappers';

/** QA-007: DeploymentRef matches the spec and its deployment_id is pollable. */

function appWith(services: unknown[]) {
  const hub = {
    liveInventory: () => ({ services, containers: [] }),
    nodeInfoFor: () => undefined,
  };
  const ctx = {
    db: {},
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['read', 'write'] } }),
  } as never);
}

const svc = (name: string, stack: string, running: number, desired: number) => ({
  id: `id-${name}`,
  name,
  image: 'nginx:1',
  mode: 'replicated',
  runningReplicas: running,
  desiredReplicas: desired,
  labels: { 'com.docker.stack.namespace': stack },
  networks: [],
  env: [],
  ports: [],
  createdAt: 0,
  updatedAt: 0,
});

describe('DeploymentRef (QA-007)', () => {
  it('maps the service layer shape to the declared snake_case DTO', () => {
    expect(deploymentRefToDto({ id: 'st1', deploymentId: 'stack:shop' })).toEqual({ id: 'st1', deployment_id: 'stack:shop' });
  });

  it('GET /deployments/stack:<name> polls the whole stack', async () => {
    const app = appWith([svc('shop_web', 'shop', 1, 2), svc('shop_db', 'shop', 1, 1), svc('other_x', 'other', 0, 1)]);
    const res = await app.request('/deployments/stack:shop', { headers: { authorization: 'Bearer swarmy_test' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployment_id: 'stack:shop', phase: 'converging', desired: 3, ready: 2 });
  });

  it('an unknown stack deployment is 404', async () => {
    const res = await appWith([]).request('/deployments/stack:nope', { headers: { authorization: 'Bearer swarmy_test' } });
    expect(res.status).toBe(404);
  });
});
