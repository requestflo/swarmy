import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine } from './engine';
import { ACTION_CATALOG } from './describe';
import { defaultPolicyInputs } from './defaults';
import { ACTIONS, type Principal, type Resource } from './types';

const member: Principal = { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], attributes: {} };
const model = (id: string, labels: Record<string, string> = {}): Resource => ({ type: 'aiModel', id, orgId: 'o1', labels });

describe('AI gateway action (ai.use)', () => {
  it('is registered and catalogued', () => {
    expect(ACTIONS).toContain('ai.use');
    expect(ACTION_CATALOG.some((c) => c.id === 'ai.use')).toBe(true);
  });

  it('members may use models by default', () => {
    const engine = JsonPolicyEngine.withDefaults();
    expect(engine.evaluate({ principal: member, action: 'ai.use', resource: model('smart', { 'swarmy.ai.provider': 'anthropic' }) }).decision).toBe('permit');
  });

  it('an org can forbid paid models for members (forbid wins)', () => {
    const engine = new JsonPolicyEngine([
      ...defaultPolicyInputs().map((p) => ({ ...p, id: `default:${p.key}` })),
      {
        id: 'no-paid',
        name: 'Members use free models only',
        effect: 'forbid',
        priority: 80,
        enabled: true,
        source: JSON.stringify({ roles: ['member'], actions: ['ai.use'], resourceTypes: ['aiModel'], resourceLabels: { 'swarmy.ai.cost': 'paid' } }),
      },
    ]);
    expect(engine.evaluate({ principal: member, action: 'ai.use', resource: model('smart', { 'swarmy.ai.cost': 'paid' }) }).decision).toBe('deny');
    expect(engine.evaluate({ principal: member, action: 'ai.use', resource: model('ollama/llama3.2:3b', { 'swarmy.ai.cost': 'free' }) }).decision).toBe('permit');
    const admin: Principal = { ...member, roles: ['admin'] };
    // forbid names members only; admins keep their superuser permit.
    expect(engine.evaluate({ principal: admin, action: 'ai.use', resource: model('smart', { 'swarmy.ai.cost': 'paid' }) }).decision).toBe('permit');
  });
});
