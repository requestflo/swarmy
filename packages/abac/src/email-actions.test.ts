import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine } from './engine';
import { ACTION_CATALOG } from './describe';
import { ACTIONS, type Principal, type Resource } from './types';

const member: Principal = { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], groups: [], attributes: {} };
const admin: Principal = { ...member, roles: ['admin'] };
const owner: Principal = { ...member, roles: ['owner'] };
const org: Resource = { type: 'org', id: 'o1', orgId: 'o1', labels: {} };

describe('email service actions (email.write / email.send)', () => {
  it('are registered and catalogued', () => {
    for (const a of ['email.write', 'email.send'] as const) {
      expect(ACTIONS).toContain(a);
      expect(ACTION_CATALOG.some((c) => c.id === a)).toBe(true);
    }
  });

  it('defaults: owners and admins only; members need a grant', () => {
    const engine = JsonPolicyEngine.withDefaults();
    for (const action of ['email.write', 'email.send'] as const) {
      for (const p of [owner, admin]) expect(engine.evaluate({ principal: p, action, resource: org }).decision).toBe('permit');
      expect(engine.evaluate({ principal: member, action, resource: org }).decision).toBe('deny');
    }
  });
});
