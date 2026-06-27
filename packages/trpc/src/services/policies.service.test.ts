import { describe, expect, it } from 'bun:test';
import { validatePolicy, simulatePolicy, policySchema } from './policies.service';
import type { OrgContext } from '../context';

describe('validatePolicy', () => {
  it('accepts a well-formed policy doc', () => {
    const r = validatePolicy(JSON.stringify({ roles: ['member'], actions: ['service.read'] }));
    expect(r.valid).toBe(true);
  });

  it('rejects malformed JSON with a message', () => {
    const r = validatePolicy('{ not json');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('JSON');
  });

  it('rejects an invalid relation', () => {
    const r = validatePolicy(JSON.stringify({ relations: ['superuser'] }));
    expect(r.valid).toBe(false);
  });
});

describe('policySchema', () => {
  it('exposes the action catalogue and clause list', () => {
    const s = policySchema();
    expect(s.actions).toContain('service.restart');
    expect(s.relations).toEqual(['owner', 'operator', 'viewer']);
    expect(s.clauses.some((c) => c.key === 'relations')).toBe(true);
  });
});

function simCtx(role: 'owner' | 'admin' | 'member'): OrgContext {
  return {
    db: {
      member: { findFirst: async () => ({ id: 'm1', role, attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      node: { findFirst: async () => null },
      service: { findFirst: async () => null },
      stack: { findFirst: async () => null },
      auditLog: { create: async () => ({}) },
    },
    activeOrgId: 'org1',
    user: { id: 'u1' },
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

describe('simulatePolicy', () => {
  it('permits owner / denies member for a destructive action (default policies)', async () => {
    expect((await simulatePolicy(simCtx('owner'), { action: 'service.remove' })).decision).toBe('permit');
    expect((await simulatePolicy(simCtx('member'), { action: 'service.remove' })).decision).toBe('deny');
  });

  it('throws on an unknown action', async () => {
    await expect(simulatePolicy(simCtx('owner'), { action: 'not.an.action' })).rejects.toThrow();
  });
});
