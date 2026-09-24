import { describe, expect, it } from 'bun:test';
import { validatePolicy, simulatePolicy, policySchema, whoCanPolicy } from './policies.service';
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

describe('whoCanPolicy — "who can do X" over every member', () => {
  function whoCtx(policies: unknown[] = []): OrgContext {
    const members = [
      { id: 'm-own', userId: 'u-own', role: 'owner', attributes: {}, user: { name: 'Olive', email: 'o@x' } },
      { id: 'm-plat', userId: 'u-plat', role: 'member', attributes: { ssoGroups: ['platform'] }, user: { name: 'Pat', email: null } },
      { id: 'm-dev', userId: 'u-dev', role: 'member', attributes: {}, user: { name: 'Dev', email: 'd@x' } },
    ];
    const base = simCtx('admin') as unknown as { db: Record<string, unknown> };
    return {
      ...base,
      db: {
        ...base.db,
        member: { ...(base.db.member as object), findMany: async () => members },
        policy: { findMany: async () => policies },
      },
    } as unknown as OrgContext;
  }

  it('lists every member with the deciding policy (defaults: prod deploy is owner-only)', async () => {
    const r = await whoCanPolicy(whoCtx(), { action: 'service.deploy', resourceType: 'service', env: 'prod' });
    expect(r.resource?.env).toBe('prod');
    expect(r.rows.map((x) => [x.memberId, x.decision])).toEqual([
      ['m-own', 'permit'],
      ['m-plat', 'deny'],
      ['m-dev', 'deny'],
    ]);
    const staging = await whoCanPolicy(whoCtx(), { action: 'service.deploy', env: 'staging' });
    expect(staging.rows.every((x) => x.decision === 'permit')).toBe(true);
  });

  it('a group rule (SSO group claim) reaches only that group', async () => {
    const rule = {
      id: 'plat', name: 'platform prod', effect: 'permit', priority: 60, enabled: true,
      source: JSON.stringify({ groups: ['platform'], actions: ['service.deploy'] }),
    };
    const owner = { id: 'own', name: 'owners', effect: 'permit', priority: 100, enabled: true, source: JSON.stringify({ roles: ['owner'], actions: ['*'] }) };
    const r = await whoCanPolicy(whoCtx([owner, rule]), { action: 'service.deploy', env: 'production' });
    const plat = r.rows.find((x) => x.memberId === 'm-plat')!;
    expect(plat.decision).toBe('permit');
    expect(plat.policyId).toBe('plat');
    expect(plat.groups).toEqual(['platform']);
    expect(r.rows.find((x) => x.memberId === 'm-dev')!.decision).toBe('deny');
  });

  it('validatePolicy returns the plain-words sentence', () => {
    const v = validatePolicy(JSON.stringify({ groups: ['platform'], actions: ['terminal.open'] }), 'permit');
    expect(v.sentence).toBe('Members of platform can open a terminal.');
  });
});
