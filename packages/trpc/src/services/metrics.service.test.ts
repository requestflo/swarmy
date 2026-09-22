import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { scopeServicesToOrg, scopedNodeCounts } from './metrics.service';

function svc(id: string, stack?: string): SwarmServiceInfo {
  return {
    id,
    name: id,
    image: 'img',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: stack ? { 'com.docker.stack.namespace': stack } : {},
    networks: [],
    env: [],
    ports: [],
  } as unknown as SwarmServiceInfo;
}

describe('dashboard org scoping', () => {
  it('counts only enrolled nodes, not raw swarm members', () => {
    // Raw swarm said 2/2; the org has exactly one enrolled node.
    expect(scopedNodeCounts(['n1'], () => true)).toEqual({ online: 1, total: 1 });
    expect(scopedNodeCounts(['n1', 'n2'], (id) => id === 'n2')).toEqual({ online: 1, total: 2 });
    expect(scopedNodeCounts([], () => true)).toEqual({ online: 0, total: 0 });
  });

  it("drops services whose stack is owned only by another org", () => {
    const owners = new Map([
      ['blog', new Set(['other-org'])],
      ['shop', new Set(['o1'])],
      ['shared-name', new Set(['o1', 'other-org'])],
    ]);
    const out = scopeServicesToOrg(
      [svc('blog-db', 'blog'), svc('blog-wp', 'blog'), svc('shop-web', 'shop'), svc('x', 'shared-name'), svc('loose'), svc('sys', 'swarmy-system')],
      'o1',
      owners,
    ).map((s) => s.id);
    expect(out).toEqual(['shop-web', 'x', 'loose', 'sys']);
  });
});
