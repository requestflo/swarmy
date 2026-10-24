import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import { whoCan } from './abac-who-can';

/** whoCan over a hypothetical resource counts ReBAC grants (security review, low). */

const MEMBERS = [
  { id: 'm-own', userId: 'u-own', role: 'owner', attributes: {}, user: { name: 'Olive', email: null } },
  { id: 'm-op', userId: 'u-op', role: 'member', attributes: {}, user: { name: 'Opal', email: null } },
  { id: 'm-team', userId: 'u-team', role: 'member', attributes: { teamIds: ['t-sre'] }, user: { name: 'Sam', email: null } },
  { id: 'm-dev', userId: 'u-dev', role: 'member', attributes: {}, user: { name: 'Dev', email: null } },
];
const GRANTS = [
  { principalType: 'member', principalId: 'm-op', resourceType: 'service', resourceId: 'shop_web', relation: 'operator' },
  { principalType: 'team', principalId: 't-sre', resourceType: 'service', resourceId: 'shop_api', relation: 'owner' },
  { principalType: 'member', principalId: 'm-dev', resourceType: 'stack', resourceId: 'blog', relation: 'operator' },
];

const db = {
  member: { findMany: async () => MEMBERS },
  policy: { findMany: async () => [] },
  resourceGrant: {
    findMany: async ({ where }: { where: { resourceType: string; resourceId?: string } }) =>
      GRANTS.filter((g) => g.resourceType === where.resourceType && (where.resourceId === undefined || g.resourceId === where.resourceId)),
  },
} as unknown as DB;

const prodService = { type: 'service', id: '(any)', orgId: 'org1', labels: {}, env: 'production' };
const decisions = (rows: Awaited<ReturnType<typeof whoCan>>) => rows.map((r) => [r.memberId, r.decision]);

describe('whoCan on a described resource ("a production service")', () => {
  it('a member or team holding a grant of that type can, and the reason names the grant', async () => {
    const rows = await whoCan(db, 'org1', 'service.deploy', prodService, { hypothetical: true });
    expect(decisions(rows)).toEqual([
      ['m-own', 'permit'],
      ['m-op', 'permit'],
      ['m-team', 'permit'],
      ['m-dev', 'deny'], // a grant on a stack says nothing about services
    ]);
    expect(rows[1]!.reasons[0]).toBe('only where they hold a grant: operator on service shop_web');
    expect(rows[2]!.reasons[0]).toBe('only where they hold a grant: owner on service shop_api');
    expect(rows[0]!.reasons[0]).not.toContain('grant');
  });

  it('a grant does not reach an action the relation rule leaves out', async () => {
    const rows = await whoCan(db, 'org1', 'service.remove', prodService, { hypothetical: true });
    expect(decisions(rows).filter(([, d]) => d === 'permit')).toEqual([['m-own', 'permit']]);
  });

  it('a real resource only counts the grants on that resource', async () => {
    const web = { type: 'service', id: 'shop_web', orgId: 'org1', labels: { 'swarmy.env': 'production' } };
    const rows = await whoCan(db, 'org1', 'service.deploy', web);
    expect(decisions(rows)).toEqual([
      ['m-own', 'permit'],
      ['m-op', 'permit'],
      ['m-team', 'deny'],
      ['m-dev', 'deny'],
    ]);
    expect(rows[1]!.reasons.join(' ')).not.toContain('only where');
  });
});
