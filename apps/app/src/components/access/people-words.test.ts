import { describe, expect, test } from 'bun:test';
import { lastSeenWords, memberScopeWords } from './people-words';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('lastSeenWords (newest session, day-accurate)', () => {
  test('reads in days', () => {
    expect(lastSeenWords(null, NOW)).toBe('not signed in');
    expect(lastSeenWords(ago(3), NOW)).toBe('seen today');
    expect(lastSeenWords(ago(30), NOW)).toBe('seen yesterday');
    expect(lastSeenWords(ago(24 * 9), NOW)).toBe('seen 9 days ago');
    expect(lastSeenWords(ago(24 * 95), NOW)).toBe('seen 3 months ago');
  });
});

describe('memberScopeWords', () => {
  const grants = [
    { principalType: 'member', principalId: 'm1', resourceType: 'stack', resourceId: 's-store', relation: 'operator' },
    { principalType: 'member', principalId: 'm1', resourceType: 'stack', resourceId: 'blog', relation: 'operator' },
    { principalType: 'member', principalId: 'm1', resourceType: 'service', resourceId: 'svc-x', relation: 'owner' },
    { principalType: 'team', principalId: 'm1', resourceType: 'stack', resourceId: 's-pay', relation: 'viewer' },
  ];
  const names = (id: string) => ({ 's-store': 'storefront' })[id] ?? id;
  test('owners and admins reach every app; a member lists their app grants', () => {
    expect(memberScopeWords({ id: 'm0', role: 'admin' }, grants, names)).toBe('every app');
    expect(memberScopeWords({ id: 'm1', role: 'member' }, grants, names)).toBe('operator on storefront, blog');
    expect(memberScopeWords({ id: 'm2', role: 'member' }, grants, names)).toBeNull();
  });
});
