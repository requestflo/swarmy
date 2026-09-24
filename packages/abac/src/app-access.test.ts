import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine } from './engine';
import { ACTION_CATALOG } from './describe';
import { ACTIONS, type Principal, type Resource } from './types';

const member: Principal = { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], groups: [], attributes: {} };
const admin: Principal = { ...member, roles: ['admin'] };
const owner: Principal = { ...member, roles: ['owner'] };
const stack = (id: string, labels: Record<string, string> = {}): Resource => ({ type: 'stack', id, orgId: 'o1', labels });

describe('app.access (Protect my app)', () => {
  it('is registered and catalogued', () => {
    expect(ACTIONS).toContain('app.access');
    expect(ACTION_CATALOG.some((c) => c.id === 'app.access')).toBe(true);
  });

  it('defaults: owners and admins enter any protected app; members need a grant', () => {
    const engine = JsonPolicyEngine.withDefaults();
    for (const p of [owner, admin]) {
      expect(engine.evaluate({ principal: p, action: 'app.access', resource: stack('shop', { 'swarmy.env': 'production' }) }).decision).toBe('permit');
    }
    expect(engine.evaluate({ principal: member, action: 'app.access', resource: stack('shop') }).decision).toBe('deny');
  });

  it('an app rule admits a group (incl. SSO groups) or a named member to THAT stack only', () => {
    // groups and members are AND-ed within one rule, so an app's Access panel
    // writes one rule per kind (a group rule, a people rule).
    const rule = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: id,
      effect: 'permit' as const,
      priority: 30,
      enabled: true,
      source: JSON.stringify({
        actions: ['app.access'],
        resourceTypes: ['stack'],
        conditions: [{ attr: 'resource.id', op: 'eq', value: 'shop' }],
        ...extra,
      }),
    });
    const engine = new JsonPolicyEngine([rule('groups', { groups: ['eng'] }), rule('people', { members: ['m7'] })]);
    const sso: Principal = { ...member, attributes: { ssoGroups: ['eng'] }, groups: ['eng'] };
    const named: Principal = { ...member, memberId: 'm7' };
    expect(engine.evaluate({ principal: sso, action: 'app.access', resource: stack('shop') }).decision).toBe('permit');
    expect(engine.evaluate({ principal: named, action: 'app.access', resource: stack('shop') }).decision).toBe('permit');
    expect(engine.evaluate({ principal: sso, action: 'app.access', resource: stack('billing') }).decision).toBe('deny');
    expect(engine.evaluate({ principal: member, action: 'app.access', resource: stack('shop') }).decision).toBe('deny');
  });
});
