import { describe, expect, it } from 'bun:test';
import { GatewayStore } from './store';

const svc = (updatedAt: number, labels: Record<string, string>) =>
  ({ id: 's1', name: 'qa_web', image: 'nginx:1', mode: 'replicated', runningReplicas: 1, labels, networks: [], env: [], ports: [], createdAt: 0, updatedAt }) as never;

/** QA-043: a lagging manager's pre-patch copy must not shadow the patched service. */
describe('GatewayStore.liveServicesForOrg', () => {
  it('keeps the newest spec of a service two managers report', () => {
    const store = new GatewayStore();
    store.nodeOrg.set('fresh', 'org1');
    store.nodeOrg.set('stale', 'org1');
    store.serviceInfo.set('fresh', [svc(20, {})]);
    store.serviceInfo.set('stale', [svc(10, { 'swarmy.cache.inject': 'kv' })]);
    const [s] = store.liveServicesForOrg('org1');
    expect(s!.updatedAt).toBe(20);
    expect(s!.labels['swarmy.cache.inject']).toBeUndefined();
  });
});
