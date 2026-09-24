import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine, PolicyEngine } from './engine';
import { defaultPolicyInputs } from './defaults';
import type { AuthzRequest, PolicyInput, Principal, Resource } from './types';

const DEFAULTS_AS_INPUTS: PolicyInput[] = defaultPolicyInputs().map((p) => ({ ...p, id: `default:${p.key}` }));

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

  // Destructive-action sweep (owner decision 2026-09-24): the actions every
  // destructive mutation is gated on. Owners/admins keep all of them (no
  // lockout); members are refused all of them by default.
  const DESTRUCTIVE = [
    'service.remove',
    'stack.remove',
    'node.remove',
    'token.revoke',
    'member.write',
    'policy.write',
    'authconfig.write',
    'data.destroy',
    'data.restore',
    'data.failover',
    'backup.remove',
    'secret.delete',
    'dns.remove',
    'ingress.remove',
    'cicd.remove',
  ] as const;

  it('owner + admin keep every destructive action (no lockout)', () => {
    for (const action of DESTRUCTIVE) {
      for (const role of ['owner', 'admin'] as const) {
        expect(engine.evaluate({ principal: principal({ roles: [role] }), action }).decision).toBe('permit');
      }
    }
  });

  it('a member is denied every destructive action by default', () => {
    for (const action of DESTRUCTIVE) {
      expect(engine.evaluate({ principal: principal(), action }).decision).toBe('deny');
    }
  });

  it("a member keeps today's safe ops the sweep gated (drain, scale, restart, domain removal)", () => {
    for (const action of ['node.drain', 'service.scale', 'service.restart', 'ingress.write'] as const) {
      expect(engine.evaluate({ principal: principal(), action }).decision).toBe('permit');
    }
  });

  it('an org can grant members a destructive action with one policy', () => {
    const custom = new JsonPolicyEngine([
      ...DEFAULTS_AS_INPUTS,
      policy({ id: 'members-restore', priority: 60, source: JSON.stringify({ roles: ['member'], actions: ['data.restore'] }) }),
    ]);
    expect(custom.evaluate({ principal: principal(), action: 'data.restore' }).decision).toBe('permit');
    expect(custom.evaluate({ principal: principal(), action: 'data.destroy' }).decision).toBe('deny');
  });

  it('PolicyEngine alias equals JsonPolicyEngine', () => {
    expect(PolicyEngine).toBe(JsonPolicyEngine);
  });
});

describe('attribute-based defaults (members free outside production)', () => {
  const engine = JsonPolicyEngine.withDefaults();
  const prod = resource({ labels: { 'swarmy.env': 'production' } });
  const staging = resource({ labels: { 'swarmy.env': 'staging' } });
  const OPS = ['service.deploy', 'service.configure', 'service.scale', 'service.restart', 'stack.deploy'] as const;

  it('members deploy / configure / scale / restart non-prod and unlabelled apps', () => {
    for (const action of OPS) {
      expect(engine.evaluate({ principal: principal(), action, resource: staging }).decision).toBe('permit');
      expect(engine.evaluate({ principal: principal(), action, resource: resource() }).decision).toBe('permit');
      // Collection-scope (new stack, no resource yet): unknown env = non-prod.
      expect(engine.evaluate({ principal: principal(), action }).decision).toBe('permit');
    }
  });

  it('members are refused the same ops on production (prod alias counts)', () => {
    for (const action of OPS) {
      expect(engine.evaluate({ principal: principal(), action, resource: prod }).decision).toBe('deny');
      const alias = resource({ labels: { 'swarmy.env': 'prod' } });
      expect(engine.evaluate({ principal: principal(), action, resource: alias }).decision).toBe('deny');
    }
  });

  it('terminal, secrets.read and mesh.connect need an explicit grant, even outside prod', () => {
    for (const action of ['terminal.open', 'secrets.read', 'mesh.connect'] as const) {
      expect(engine.evaluate({ principal: principal(), action, resource: staging }).decision).toBe('deny');
      expect(engine.evaluate({ principal: principal({ roles: ['admin'] }), action, resource: prod }).decision).toBe(
        'permit',
      );
    }
  });

  it('a ResourceGrant operator may deploy that production app', () => {
    const granted = resource({ labels: { 'swarmy.env': 'production' }, principalRelations: ['operator', 'viewer'] });
    expect(engine.evaluate({ principal: principal(), action: 'service.deploy', resource: granted }).decision).toBe(
      'permit',
    );
    expect(engine.evaluate({ principal: principal(), action: 'service.remove', resource: granted }).decision).toBe(
      'deny',
    );
  });

  it('a group policy grants prod deploy to members of that group only', () => {
    const custom = new JsonPolicyEngine([
      ...DEFAULTS_AS_INPUTS,
      policy({
        id: 'platform-prod',
        priority: 60,
        source: JSON.stringify({
          groups: ['platform'],
          actions: ['service.deploy', 'terminal.open'],
          conditions: [{ attr: 'resource.env', op: 'eq', value: 'production' }],
        }),
      }),
    ]);
    const platform = principal({ attributes: { groups: ['platform'] } });
    expect(custom.evaluate({ principal: platform, action: 'service.deploy', resource: prod }).policyId).toBe(
      'platform-prod',
    );
    expect(custom.evaluate({ principal: platform, action: 'terminal.open', resource: prod }).decision).toBe('permit');
    expect(custom.evaluate({ principal: platform, action: 'terminal.open', resource: staging }).decision).toBe('deny');
    expect(custom.evaluate({ principal: principal(), action: 'service.deploy', resource: prod }).decision).toBe('deny');
  });

  it('a group forbid beats the member default outside prod', () => {
    const custom = new JsonPolicyEngine([
      ...DEFAULTS_AS_INPUTS,
      policy({
        id: 'no-contractors',
        effect: 'forbid',
        source: JSON.stringify({ groups: ['contractors'], actions: ['service.deploy'] }),
      }),
    ]);
    const contractor = principal({ teamIds: ['contractors'] });
    expect(custom.evaluate({ principal: contractor, action: 'service.deploy', resource: staging }).decision).toBe(
      'deny',
    );
  });

  it('a members clause names one person', () => {
    const custom = new JsonPolicyEngine([
      policy({ id: 'alice', source: JSON.stringify({ members: ['m-alice'], actions: ['secrets.read'] }) }),
    ]);
    expect(
      custom.evaluate({ principal: principal({ memberId: 'm-alice' }), action: 'secrets.read' }).decision,
    ).toBe('permit');
    expect(custom.evaluate({ principal: principal(), action: 'secrets.read' }).decision).toBe('deny');
  });

  it('PolicyEngine alias still equals JsonPolicyEngine', () => {
    expect(PolicyEngine).toBe(JsonPolicyEngine);
  });
});
