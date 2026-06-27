import { describe, expect, test } from 'bun:test';
import {
  buildHeadscaleAcl,
  buildNetbirdPolicyPlan,
  principalTagForRoute,
  targetTagForRoute,
  type MeshAccessIntent,
} from './acl';

function intent(): MeshAccessIntent {
  return {
    orgId: 'org_1',
    grants: [
      {
        id: 'route_b',
        principalTag: principalTagForRoute('route_b'),
        targetTag: targetTagForRoute('route_b'),
        ports: [5432],
        proto: 'tcp',
      },
      {
        id: 'route_a',
        principalTag: principalTagForRoute('route_a'),
        targetTag: targetTagForRoute('route_a'),
        ports: [],
      },
    ],
  };
}

describe('tag helpers', () => {
  test('deterministic principal/target tags', () => {
    expect(principalTagForRoute('xyz')).toBe('tag:dc-xyz');
    expect(targetTagForRoute('xyz')).toBe('tag:svc-xyz');
  });
});

describe('buildHeadscaleAcl', () => {
  test('exact golden, sorted by grant id', () => {
    const out = buildHeadscaleAcl(intent());
    const parsed = JSON.parse(out);
    // route_a sorts before route_b.
    expect(parsed.acls[0].dst).toEqual(['tag:svc-route_a:*']);
    expect(parsed.acls[1].dst).toEqual(['tag:svc-route_b:5432']);
    expect(parsed.acls[1].proto).toBe('tcp');
    expect(parsed.acls[0].proto).toBeUndefined();
    expect(parsed.tagOwners['tag:dc-route_a']).toEqual(['swarmy']);
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('buildNetbirdPolicyPlan', () => {
  test('produces sorted groups + one policy per grant', () => {
    const plan = buildNetbirdPolicyPlan(intent());
    expect(plan.policies.map((p) => p.name)).toEqual(['dc-route_a', 'dc-route_b']);
    const tcp = plan.policies.find((p) => p.name === 'dc-route_b')!;
    expect(tcp.protocol).toBe('tcp');
    expect(tcp.ports).toEqual(['5432']);
    const all = plan.policies.find((p) => p.name === 'dc-route_a')!;
    expect(all.protocol).toBe('all');
    // groups are unique + sorted.
    const names = plan.groups.map((g) => g.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
