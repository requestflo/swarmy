import { describe, expect, it } from 'bun:test';
import { conditionHolds, lookupAttr, normaliseEnv, principalGroups, resourceEnv } from './attrs';
import { parsePolicyDoc, PolicyParseError } from './policy';
import { policyDocToCedar, buildCedarContext } from './cedar';
import { ACTION_CATALOG, describePolicy } from './describe';
import { ACTIONS, type Principal, type Resource } from './types';
import { DEFAULT_POLICY_SPECS } from './defaults';

const P: Principal = {
  userId: 'u1',
  memberId: 'm1',
  orgId: 'o1',
  roles: ['member'],
  teamIds: ['t-web'],
  attributes: { groups: ['platform', 'oncall'], team: 'payments' },
};
const R = (labels: Record<string, unknown>): Resource => ({ type: 'service', id: 's1', orgId: 'o1', labels });

describe('environment attribute', () => {
  it('normalises aliases and blanks', () => {
    expect(normaliseEnv('PROD')).toBe('production');
    expect(normaliseEnv(' production ')).toBe('production');
    expect(normaliseEnv('stage')).toBe('staging');
    expect(normaliseEnv('qa')).toBe('qa');
    expect(normaliseEnv('')).toBeNull();
    expect(normaliseEnv(undefined)).toBeNull();
  });

  it('reads swarmy.env, falls back to the git-apps label, explicit env wins', () => {
    expect(resourceEnv(R({ 'swarmy.env': 'prod' }))).toBe('production');
    expect(resourceEnv(R({ 'swarmy.app.environment': 'staging' }))).toBe('staging');
    expect(resourceEnv({ env: 'prd', labels: { 'swarmy.env': 'dev' } })).toBe('production');
    expect(resourceEnv(R({}))).toBeNull();
    expect(resourceEnv(null)).toBeNull();
  });
});

describe('attribute lookup + conditions', () => {
  it('groups = attributes.groups ∪ teamIds', () => {
    expect(principalGroups(P).sort()).toEqual(['oncall', 'platform', 't-web']);
  });

  it('resolves resource and principal paths as string lists', () => {
    const r = R({ 'swarmy.env': 'production', app: 'web' });
    expect(lookupAttr('resource.env', P, r)).toEqual(['production']);
    expect(lookupAttr('resource.label.app', P, r)).toEqual(['web']);
    expect(lookupAttr('resource.type', P, r)).toEqual(['service']);
    expect(lookupAttr('principal.team', P, r)).toEqual(['payments']);
    expect(lookupAttr('principal.role', P, r)).toEqual(['member']);
    expect(lookupAttr('resource.env', P, null)).toEqual([]);
  });

  it('a missing attribute is "not equal" (unknown env counts as non-production)', () => {
    expect(conditionHolds({ attr: 'resource.env', op: 'ne', value: 'production' }, [])).toBe(true);
    expect(conditionHolds({ attr: 'resource.env', op: 'eq', value: 'production' }, [])).toBe(false);
    expect(conditionHolds({ attr: 'x', op: 'in', value: ['a', 'b'] }, ['b'])).toBe(true);
    expect(conditionHolds({ attr: 'x', op: 'notIn', value: ['a', 'b'] }, ['c'])).toBe(true);
    expect(conditionHolds({ attr: 'x', op: 'exists' }, [])).toBe(false);
    expect(conditionHolds({ attr: 'x', op: 'notExists' }, [])).toBe(true);
  });
});

describe('policy doc v2 parsing', () => {
  it('accepts groups, members and conditions; normalises env values', () => {
    const doc = parsePolicyDoc(
      JSON.stringify({
        groups: ['platform'],
        members: ['m1'],
        actions: ['service.deploy'],
        conditions: [{ attr: 'resource.env', op: 'in', value: ['prod', 'staging'] }],
      }),
    );
    expect(doc.groups).toEqual(['platform']);
    expect(doc.conditions).toEqual([{ attr: 'resource.env', op: 'in', value: ['production', 'staging'] }]);
  });

  it('keeps v1 documents byte-compatible', () => {
    expect(parsePolicyDoc(JSON.stringify({ roles: ['member'], actions: ['service.read'] }))).toEqual({
      roles: ['member'],
      actions: ['service.read'],
    });
  });

  it('rejects bad attribute paths, ops and values', () => {
    const bad = (conditions: unknown) => () => parsePolicyDoc(JSON.stringify({ conditions }));
    expect(bad([{ attr: 'env', op: 'eq', value: 'x' }])).toThrow(PolicyParseError);
    expect(bad([{ attr: 'resource.env', op: 'like', value: 'x' }])).toThrow(PolicyParseError);
    expect(bad([{ attr: 'resource.env', op: 'in', value: 'x' }])).toThrow(PolicyParseError);
    expect(bad({})).toThrow(PolicyParseError);
  });
});

describe('cedar translation of v2 clauses', () => {
  it('emits groups, members and condition predicates over context.attrs', () => {
    const src = policyDocToCedar('p', 'permit', {
      groups: ['platform'],
      members: ['m1'],
      conditions: [
        { attr: 'resource.env', op: 'ne', value: 'production' },
        { attr: 'resource.label.app', op: 'in', value: ['web', 'api'] },
        { attr: 'principal.team', op: 'exists' },
      ],
    });
    expect(src).toContain('context.groups.containsAny(["platform"])');
    expect(src).toContain('["m1"].contains(context.memberId)');
    expect(src).toContain('!(context.attrs has "resource.env" && context.attrs["resource.env"].contains("production"))');
    expect(src).toContain('context.attrs["resource.label.app"].containsAny(["web", "api"])');
    expect(src).toContain('(context.attrs has "principal.team")');
  });

  it('pre-computes attrs with the same lookup as the JSON engine (unset keys absent)', () => {
    const ctx = buildCedarContext(
      { principal: P, action: 'service.deploy', resource: R({ 'swarmy.env': 'prod' }) },
      ['resource.env', 'resource.label.app'],
    );
    expect(ctx.attrs).toEqual({ 'resource.env': ['production'] });
    expect((ctx.groups as string[]).sort()).toEqual(['oncall', 'platform', 't-web']);
  });
});

describe('plain-words rules', () => {
  it('every action has a friendly label', () => {
    const labelled = new Set(ACTION_CATALOG.map((a) => a.id));
    for (const a of ACTIONS) expect(labelled.has(a)).toBe(true);
  });

  it('renders a group + env rule as a sentence', () => {
    expect(
      describePolicy('permit', {
        groups: ['platform'],
        actions: ['service.deploy', 'service.restart'],
        resourceTypes: ['service'],
        conditions: [{ attr: 'resource.env', op: 'eq', value: 'production' }],
      }),
    ).toBe('Members of platform can deploy apps and restart on apps where env is production.');
  });

  it('renders the seeded defaults', () => {
    const safe = DEFAULT_POLICY_SPECS.find((s) => s.key === 'member-safe-ops')!;
    expect(describePolicy('permit', safe.doc)).toContain('where env is not production');
    expect(describePolicy('permit', { roles: ['owner'], actions: ['*'] })).toBe('Owners can do anything.');
  });
});
