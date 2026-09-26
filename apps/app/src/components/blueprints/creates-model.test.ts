import { describe, expect, it } from 'bun:test';
import type { BlueprintMetaView, BlueprintPlanView } from '@swarmy/core';
import { graphModel } from './creates-model';

const meta = (over: Partial<BlueprintMetaView>): BlueprintMetaView => ({
  id: 'umami',
  name: 'Umami',
  tagline: 'Stats',
  category: 'analytics',
  resources: ['Postgres', 'App', 'Route'],
  docOnly: false,
  supportsDomain: true,
  options: [],
  ...over,
});

describe('what-gets-created graph', () => {
  it('draws HTTPS → the app → managed Postgres and its nightly backup', () => {
    const g = graphModel(meta({ services: ['umami'], managed: ['postgres'], primaryService: 'umami' }), { host: 'umami-stats.x.sslip.io' });
    expect(g.entry?.detail).toBe('umami-stats.x.sslip.io');
    expect(g.app.label).toBe('umami');
    expect(g.data.map((d) => d.label)).toEqual(['postgres', 'nightly backup']);
  });

  it('takes the services from the plan for built-ins, and drops HTTPS for private apps', () => {
    const plan: BlueprintPlanView = {
      id: 'worker',
      stackName: 'jobs',
      summary: '',
      steps: [
        { kind: 'cache.provision', label: 'cache', detail: {} },
        { kind: 'stack.deploy', label: 'deploy', detail: { services: 'worker' } },
      ],
    };
    const g = graphModel(meta({ id: 'worker', resources: ['Private'] }), { plan });
    expect(g.entry).toBeNull();
    expect(g.app.label).toBe('worker');
    expect(g.data.map((d) => d.label)).toEqual(['cache']);
  });
});
