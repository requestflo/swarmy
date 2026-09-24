import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine } from './engine';
import { ACTION_CATALOG } from './describe';
import { ACTIONS, type Principal, type Resource } from './types';

const member: Principal = { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], attributes: {} };
const admin: Principal = { ...member, roles: ['admin'] };
const db = (labels: Record<string, string> = {}): Resource => ({ type: 'service', id: 'app_db', orgId: 'o1', labels });

describe('database studio actions (data.read / data.write)', () => {
  const engine = JsonPolicyEngine.withDefaults();

  it('are registered and catalogued', () => {
    for (const a of ['data.read', 'data.write'] as const) {
      expect(ACTIONS).toContain(a);
      expect(ACTION_CATALOG.some((c) => c.id === a)).toBe(true);
    }
  });

  it('members read non-production databases, not production', () => {
    expect(engine.evaluate({ principal: member, action: 'data.read', resource: db() }).decision).toBe('permit');
    expect(engine.evaluate({ principal: member, action: 'data.read', resource: db({ 'swarmy.env': 'staging' }) }).decision).toBe('permit');
    expect(engine.evaluate({ principal: member, action: 'data.read', resource: db({ 'swarmy.env': 'production' }) }).decision).toBe('deny');
  });

  it('writes and destructive statements need a grant, even outside production', () => {
    for (const action of ['data.write', 'data.destroy'] as const) {
      expect(engine.evaluate({ principal: member, action, resource: db() }).decision).toBe('deny');
      expect(engine.evaluate({ principal: admin, action, resource: db({ 'swarmy.env': 'production' }) }).decision).toBe('permit');
    }
  });
});
