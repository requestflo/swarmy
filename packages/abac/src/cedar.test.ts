import { describe, expect, it } from 'bun:test';
import { CedarPolicyEngine, policyDocToCedar, tryCreateCedarEngine } from './cedar';
import type { PolicyInput } from './types';

describe('policyDocToCedar translation', () => {
  it('emits a wildcard permit with no conditions for actions:[*]', () => {
    const src = policyDocToCedar('p1', 'permit', { actions: ['*'] });
    expect(src).toContain('@id("p1")');
    expect(src).toContain('permit(principal, action, resource)');
    expect(src.trim().endsWith(';')).toBe(true);
    // No `when` block when only a wildcard action is present.
    expect(src).not.toContain('when');
  });

  it('emits an action-membership condition', () => {
    const src = policyDocToCedar('p2', 'permit', { actions: ['service.restart', 'service.scale'] });
    expect(src).toContain('"service.restart"');
    expect(src).toContain('"service.scale"');
    expect(src).toContain('context.action');
  });

  it('emits role, label, attribute and relation conditions', () => {
    const src = policyDocToCedar('p3', 'forbid', {
      roles: ['member'],
      resourceLabels: { env: 'prod' },
      attributes: { team: 'payments' },
      relations: ['operator'],
    });
    expect(src).toContain('forbid(principal, action, resource)');
    expect(src).toContain('context.roles.containsAny(["member"])');
    expect(src).toContain('context.labels["env"] == "prod"');
    expect(src).toContain('context.attributes["team"] == "payments"');
    expect(src).toContain('context.relations.containsAny(["operator"])');
  });

  it('escapes quotes in values', () => {
    const src = policyDocToCedar('p4', 'permit', { attributes: { name: 'a"b' } });
    expect(src).toContain('a\\"b');
  });
});

describe('CedarPolicyEngine fallback', () => {
  const policies: PolicyInput[] = [
    {
      id: 'allow',
      name: 'allow members read',
      effect: 'permit',
      priority: 1,
      enabled: true,
      source: JSON.stringify({ roles: ['member'], actions: ['service.read'] }),
    },
  ];

  it('falls back to the JSON engine when cedar throws', () => {
    // A stub cedar whose isAuthorized throws — the engine must still decide.
    const engine = new CedarPolicyEngine(policies, {
      isAuthorized: () => {
        throw new Error('boom');
      },
    });
    const d = engine.evaluate({
      principal: { userId: 'u', memberId: 'm', orgId: 'o', roles: ['member'], teamIds: [], attributes: {} },
      action: 'service.read',
    });
    expect(d.decision).toBe('permit');
  });

  it('honours a cedar allow decision', () => {
    const engine = new CedarPolicyEngine(policies, {
      isAuthorized: () => ({ type: 'success', response: { decision: 'allow' } }),
    });
    const d = engine.evaluate({
      principal: { userId: 'u', memberId: 'm', orgId: 'o', roles: ['admin'], teamIds: [], attributes: {} },
      action: 'node.remove',
    });
    expect(d.decision).toBe('permit');
  });

  it('renders the full policy set to cedar source', () => {
    const engine = new CedarPolicyEngine(policies, { isAuthorized: () => ({}) });
    expect(engine.toCedarSource()).toContain('@id("allow")');
  });
});

describe('tryCreateCedarEngine', () => {
  it('returns null when @cedar-policy/cedar-wasm is absent (current install)', async () => {
    const engine = await tryCreateCedarEngine([]);
    // The dependency is not installed in this workspace, so we expect a graceful null.
    expect(engine).toBeNull();
  });
});
