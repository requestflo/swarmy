import { describe, expect, it } from 'bun:test';
import { expandRelations, resolveRelations, withRelations, type GrantEdge } from './grants';
import { JsonPolicyEngine } from './engine';
import type { PolicyInput, Resource } from './types';

const grants: GrantEdge[] = [
  { principalType: 'member', principalId: 'm1', resourceType: 'service', resourceId: 's1', relation: 'operator' },
  { principalType: 'team', principalId: 't1', resourceType: 'service', resourceId: 's2', relation: 'owner' },
  { principalType: 'member', principalId: 'm9', resourceType: 'service', resourceId: 's1', relation: 'owner' },
];

describe('resolveRelations', () => {
  it('resolves a direct member grant', () => {
    const rels = resolveRelations({ memberId: 'm1', teamIds: [] }, { type: 'service', id: 's1' }, grants);
    expect(rels).toContain('operator');
    expect(rels).toContain('viewer'); // operator implies viewer
    expect(rels).not.toContain('owner');
  });

  it('resolves a team grant and expands owner implications', () => {
    const rels = resolveRelations({ memberId: 'm1', teamIds: ['t1'] }, { type: 'service', id: 's2' }, grants);
    expect(rels.sort()).toEqual(['operator', 'owner', 'viewer']);
  });

  it('returns nothing when no grant matches', () => {
    expect(resolveRelations({ memberId: 'mX', teamIds: [] }, { type: 'service', id: 's1' }, grants)).toEqual(
      [],
    );
  });

  it('does not leak other members grants', () => {
    const rels = resolveRelations({ memberId: 'm1', teamIds: [] }, { type: 'service', id: 's1' }, grants);
    expect(rels).not.toContain('owner'); // m9 owns s1, not m1
  });
});

describe('expandRelations', () => {
  it('owner implies operator and viewer', () => {
    expect(expandRelations(['owner']).sort()).toEqual(['operator', 'owner', 'viewer']);
  });
  it('operator implies viewer', () => {
    expect(expandRelations(['operator']).sort()).toEqual(['operator', 'viewer']);
  });
});

describe('ReBAC end-to-end with the engine', () => {
  const policies: PolicyInput[] = [
    {
      id: 'op',
      name: 'operators may restart',
      effect: 'permit',
      priority: 10,
      enabled: true,
      source: JSON.stringify({ relations: ['operator'], actions: ['service.restart'] }),
    },
  ];
  const engine = new JsonPolicyEngine(policies);

  it('permits the operator of a resource', () => {
    const resource: Resource = withRelations(
      { type: 'service', id: 's1', orgId: 'o1', labels: {} },
      { memberId: 'm1', teamIds: [] },
      grants,
    );
    expect(
      engine.evaluate({
        principal: { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], attributes: {} },
        action: 'service.restart',
        resource,
      }).decision,
    ).toBe('permit');
  });

  it('denies a non-operator of the resource', () => {
    const resource: Resource = withRelations(
      { type: 'service', id: 's1', orgId: 'o1', labels: {} },
      { memberId: 'mX', teamIds: [] },
      grants,
    );
    expect(
      engine.evaluate({
        principal: { userId: 'uX', memberId: 'mX', orgId: 'o1', roles: ['member'], teamIds: [], attributes: {} },
        action: 'service.restart',
        resource,
      }).decision,
    ).toBe('deny');
  });
});
