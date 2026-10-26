import { describe, expect, it } from 'bun:test';
import { tryCreateCedarEngine } from './cedar';
import { defaultPolicyInputs } from './defaults';
import { INCIDENT_SPECS } from './defaults-incidents';
import { ACTION_CATALOG, describePolicy } from './describe';
import { JsonPolicyEngine } from './engine';
import { ACTIONS, type Principal, type Resource } from './types';

const member: Principal = { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], groups: [], attributes: {} };
const incident: Resource = { type: 'incident', id: 'inc1', orgId: 'o1', labels: {} };
const DEFAULTS = defaultPolicyInputs().map((p) => ({ ...p, id: `default:${p.key}` }));

describe('incident.take (members take incidents by default)', () => {
  it('is registered and catalogued', () => {
    expect(ACTIONS).toContain('incident.take');
    expect(ACTION_CATALOG.find((c) => c.id === 'incident.take')?.label).toBe('take incidents');
  });

  it('defaults: owners, admins and members may take an incident', () => {
    const engine = new JsonPolicyEngine(DEFAULTS);
    for (const role of ['owner', 'admin', 'member'] as const) {
      const r = engine.evaluate({ principal: { ...member, roles: [role] }, action: 'incident.take', resource: incident });
      expect(r.decision).toBe('permit');
    }
    expect(engine.evaluate({ principal: member, action: 'incident.take', resource: incident }).policyId).toBe('default:member-incident-take');
  });

  it('gives members nothing destructive on the way', () => {
    const engine = new JsonPolicyEngine(DEFAULTS);
    expect(engine.evaluate({ principal: member, action: 'data.destroy', resource: incident }).decision).toBe('deny');
    expect(engine.evaluate({ principal: member, action: 'policy.write', resource: null }).decision).toBe('deny');
  });

  it('a forbid rule on incidents wins over the default permit', () => {
    const forbid = { id: 'no-take', name: 'No taking', effect: 'forbid' as const, priority: 10, enabled: true, source: JSON.stringify({ roles: ['member'], actions: ['incident.take'] }) };
    const engine = new JsonPolicyEngine([...DEFAULTS, forbid]);
    expect(engine.evaluate({ principal: member, action: 'incident.take', resource: incident }).decision).toBe('deny');
  });

  it('the Cedar engine agrees (when cedar-wasm is installed)', async () => {
    const cedar = await tryCreateCedarEngine(DEFAULTS);
    if (!cedar) return;
    const json = new JsonPolicyEngine(DEFAULTS);
    for (const role of ['owner', 'member'] as const) {
      const req = { principal: { ...member, roles: [role] }, action: 'incident.take' as const, resource: incident };
      expect(cedar.evaluate(req).decision).toBe(json.evaluate(req).decision);
    }
  });

  it('reads as plain words in the rules editor', () => {
    const [spec] = INCIDENT_SPECS;
    expect(describePolicy(spec!.effect, spec!.doc)).toBe('Members can take incidents.');
  });
});
