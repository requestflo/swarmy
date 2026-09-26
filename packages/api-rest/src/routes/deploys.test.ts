import { describe, expect, it } from 'bun:test';
import { deployEventBus, type OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';

/** GET /deploys/{id}/events — the Deploying screen's stream over REST, org-scoped. */
function appFor(orgId: string) {
  const ctx = {
    db: {},
    hub: {},
    user: { id: 'u1', email: 'dev@acme.test', name: 'Dev' },
    activeOrgId: orgId,
    membership: { role: 'member', orgId },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({ resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['read'], kind: 'api_key' } }) });
}
const get = (orgId: string, path: string) => appFor(orgId).request(path, { headers: { authorization: 'Bearer swk_test' } });

describe('GET /deploys/{id}/events', () => {
  it('returns the buffered events, snake_case', async () => {
    const id = deployEventBus.begin('org_rest_a', 'blog');
    deployEventBus.push('org_rest_a', {
      deployId: id,
      stack: 'blog',
      service: 'blog_ghost',
      node: 'london-1',
      stage: 'pull',
      status: 'progress',
      at: 5,
      message: 'ghost:5.96-alpine: 3 of 7 layers',
      detail: { layersTotal: 7, layersDone: 3 },
    });
    const res = await get('org_rest_a', `/deploys/${id}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy_id: string; stack: string; done: boolean; data: Array<Record<string, unknown>> };
    expect(body.deploy_id).toBe(id);
    expect(body.done).toBe(false);
    expect(body.data[0]).toMatchObject({ seq: 1, stage: 'pull', node: 'london-1', service: 'blog_ghost', detail: { layers_total: 7, layers_done: 3 } });
    deployEventBus.finish(id);
  });

  it('another org’s deploy is 404', async () => {
    const id = deployEventBus.begin('org_rest_a', 'blog');
    expect((await get('org_rest_b', `/deploys/${id}/events`)).status).toBe(404);
    deployEventBus.finish(id);
  });

  it('the spec documents it and DeploymentRef carries deploy_id', async () => {
    const doc = (await (await appFor('org_rest_a').request('/openapi.json')).json()) as {
      paths: Record<string, { get?: unknown }>;
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    expect(doc.paths['/deploys/{id}/events']?.get).toBeDefined();
    expect(doc.components.schemas.DeploymentRef!.properties.deploy_id).toBeDefined();
  });
});
