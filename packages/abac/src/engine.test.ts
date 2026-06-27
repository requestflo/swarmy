import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine, PolicyEngine } from './engine';
import type { AuthzRequest, PolicyInput, Principal, Resource } from './types';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'u1',
    memberId: 'm1',
    orgId: 'o1',
    roles: ['member'],
    teamIds: [],
    attributes: {},
    ...over,
  };
}

function resource(over: Partial<Resource> = {}): Resource {
  return { type: 'service', id: 's1', orgId: 'o1', labels: {}, ...over };
}

function policy(over: Partial<PolicyInput> & { source: string }): PolicyInput {
  return { id: 'p', name: 'p', effect: 'permit', priority: 0, enabled: true, ...over };
}

describe('JsonPolicyEngine decisions', () => {
  it('permits when a matching permit exists', () => {
    const engine = new JsonPolicyEngine([
      policy({ source: JSON.stringify({ roles: ['member'], actions: ['service.restart'] }) }),
    ]);
    const req: AuthzRequest = { principal: principal(), action: 'service.restart', resource: resource() };
    const d = engine.evaluate(req);
    expect(d.decision).toBe('permit');
    expect(d.policyId).toBe('p');
  });

  it('default-denies when nothing matches', () => {
    const engine = new JsonPolicyEngine([
      policy({ source: JSON.stringify({ roles: ['admin'], actions: ['service.restart'] }) }),
    ]);
    const d = engine.evaluate({ principal: principal(), action: 'service.restart' });
    expect(d.decision).toBe('deny');
    expect(d.policyId).toBeNull();
  });

  it('forbid wins over a permit', () => {
    const engine = new JsonPolicyEngine([
      policy({ id: 'allow', source: JSON.stringify({ roles: ['member'], actions: ['service.remove'] }) }),
      policy({
        id: 'deny',
        effect: 'forbid',
        priority: 5,
        source: JSON.stringify({ actions: ['service.remove'] }),
      }),
    ]);
    const d = engine.evaluate({ principal: principal(), action: 'service.remove', resource: resource() });
    expect(d.decision).toBe('deny');
    expect(d.policyId).toBe('deny');
  });

  it('reports highest-priority permit as the deciding policy', () => {
    const engine = new JsonPolicyEngine([
      policy({ id: 'low', priority: 1, source: JSON.stringify({ actions: ['*'] }) }),
      policy({ id: 'high', priority: 9, source: JSON.stringify({ actions: ['*'] }) }),
    ]);
    const d = engine.evaluate({ principal: principal(), action: 'service.read' });
    expect(d.policyId).toBe('high');
  });

  it('ignores disabled policies', () => {
    const engine = new JsonPolicyEngine([
      policy({ enabled: false, source: JSON.stringify({ actions: ['*'] }) }),
    ]);
    expect(engine.evaluate({ principal: principal(), action: 'node.read' }).decision).toBe('deny');
  });

  it('matches on resource labels', () => {
    const engine = new JsonPolicyEngine([
      policy({
        source: JSON.stringify({ actions: ['service.restart'], resourceLabels: { env: 'staging' } }),
      }),
    ]);
    const staging = engine.evaluate({
      principal: principal(),
      action: 'service.restart',
      resource: resource({ labels: { env: 'staging' } }),
    });
    const prod = engine.evaluate({
      principal: principal(),
      action: 'service.restart',
      resource: resource({ labels: { env: 'prod' } }),
    });
    expect(staging.decision).toBe('permit');
    expect(prod.decision).toBe('deny');
  });

  it('matches on principal attributes', () => {
    const engine = new JsonPolicyEngine([
      policy({ source: JSON.stringify({ actions: ['*'], attributes: { team: 'payments' } }) }),
    ]);
    expect(
      engine.evaluate({
        principal: principal({ attributes: { team: 'payments' } }),
        action: 'service.scale',
      }).decision,
    ).toBe('permit');
    expect(
      engine.evaluate({
        principal: principal({ attributes: { team: 'web' } }),
        action: 'service.scale',
      }).decision,
    ).toBe('deny');
  });
});

describe('PolicyEngine.withDefaults (behaviour preservation)', () => {
  const engine = JsonPolicyEngine.withDefaults();

  it('owner can do anything', () => {
    expect(
      engine.evaluate({ principal: principal({ roles: ['owner'] }), action: 'service.remove' }).decision,
    ).toBe('permit');
  });

  it('admin can do anything', () => {
    expect(
      engine.evaluate({ principal: principal({ roles: ['admin'] }), action: 'node.remove' }).decision,
    ).toBe('permit');
  });

  it('member can read but not remove', () => {
    expect(engine.evaluate({ principal: principal(), action: 'service.read' }).decision).toBe('permit');
    expect(engine.evaluate({ principal: principal(), action: 'service.remove' }).decision).toBe('deny');
  });

  it('member can run safe ops', () => {
    expect(engine.evaluate({ principal: principal(), action: 'service.restart' }).decision).toBe(
      'permit',
    );
  });

  it('PolicyEngine alias equals JsonPolicyEngine', () => {
    expect(PolicyEngine).toBe(JsonPolicyEngine);
  });
});
