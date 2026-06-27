import { describe, expect, it } from 'bun:test';
import { buildPrincipal, buildResource } from './build';
import type { GrantEdge } from './grants';

describe('buildPrincipal', () => {
  it('maps identity facts to a principal with role as an attribute', () => {
    const p = buildPrincipal({
      userId: 'u1',
      orgId: 'o1',
      role: 'admin',
      memberId: 'm1',
      teamIds: ['t1', 't2'],
      attributes: { team: 'payments', tier: 'senior' },
    });
    expect(p.roles).toEqual(['admin']);
    expect(p.memberId).toBe('m1');
    expect(p.teamIds).toEqual(['t1', 't2']);
    expect(p.attributes.team).toBe('payments');
    expect(p.attributes.memberId).toBe('m1');
    expect(p.attributes.teamIds).toEqual(['t1', 't2']);
  });

  it('tolerates missing attributes and teams', () => {
    const p = buildPrincipal({ userId: 'u1', orgId: 'o1', role: 'member' });
    expect(p.teamIds).toEqual([]);
    expect(p.attributes.teamIds).toEqual([]);
    expect(p.memberId).toBeNull();
  });
});

describe('buildResource', () => {
  const grants: GrantEdge[] = [
    { principalType: 'member', principalId: 'm1', resourceType: 'node', resourceId: 'n1', relation: 'viewer' },
  ];

  it('maps a row and resolves principal relations from grants', () => {
    const r = buildResource(
      { type: 'node', id: 'n1', orgId: 'o1', labels: { env: 'prod' } },
      { memberId: 'm1', teamIds: [] },
      grants,
    );
    expect(r.type).toBe('node');
    expect(r.labels).toEqual({ env: 'prod' });
    expect(r.principalRelations).toEqual(['viewer']);
  });

  it('defaults labels and relations when absent', () => {
    const r = buildResource({ type: 'stack', id: 'st1', orgId: 'o1' }, { memberId: 'mX', teamIds: [] });
    expect(r.labels).toEqual({});
    expect(r.principalRelations).toEqual([]);
  });
});
