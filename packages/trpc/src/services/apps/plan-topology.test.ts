import { describe, expect, it } from 'bun:test';
import { planTopology } from './plan-topology';

describe('planTopology (board 26 Graph lines)', () => {
  it('routes to services, services to the resources they bind (services left out)', () => {
    const t = planTopology({
      services: [
        { name: 'web', dependsOn: ['api', 'db'] },
        { name: 'api', dependsOn: ['db', 'cache'] },
      ],
      resources: [
        { name: 'db', type: 'postgres' },
        { name: 'cache', type: 'cache' },
      ],
      routes: [{ host: 'shop.example.com', path: '/', service: 'web', port: 3000 }],
    });
    expect(t).toEqual({
      routes: [{ host: 'shop.example.com', path: '/', service: 'web' }],
      services: [
        { name: 'web', uses: ['db'] },
        { name: 'api', uses: ['db', 'cache'] },
      ],
      resources: [
        { name: 'db', type: 'postgres' },
        { name: 'cache', type: 'cache' },
      ],
    });
  });

  it('null without a recorded desired state (an invalid swarmy.yaml)', () => {
    expect(planTopology(null)).toBeNull();
    expect(planTopology({})).toBeNull();
  });
});
