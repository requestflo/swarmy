import { describe, expect, test } from 'bun:test';
import { describeInviteLink, inviteEndsWords, usesWords } from './invite-words';

describe('describeInviteLink', () => {
  test('member on one app, capped, 7 days', () => {
    expect(describeInviteLink({ role: 'member', stackName: 'storefront', expiry: '7d', maxUses: 10 })).toBe(
      'Whoever opens this link joins as a member on storefront, up to 10 people, for 7 days.',
    );
  });
  test('admin is every app; single use; never', () => {
    expect(describeInviteLink({ role: 'admin', stackName: null, expiry: 'never', maxUses: 1 })).toBe(
      'Whoever opens this link joins as an admin on every app, one person only, until you revoke it.',
    );
  });
  test('member, whole workspace, unlimited, a day', () => {
    expect(describeInviteLink({ role: 'member', stackName: null, expiry: '1d', maxUses: null })).toBe(
      'Whoever opens this link joins as a member, any number of people, for a day.',
    );
  });
});

describe('row words', () => {
  test('uses', () => {
    expect(usesWords(3, 10)).toBe('used 3 of 10');
    expect(usesWords(2, null)).toBe('used 2');
  });
  test('ends', () => {
    const now = Date.parse('2026-09-26T00:00:00Z');
    expect(inviteEndsWords('ok', '2026-10-01T00:00:00Z', now)).toBe('expires in 5 days');
    expect(inviteEndsWords('ok', null, now)).toBe('never expires');
    expect(inviteEndsWords('expired', '2026-09-20T00:00:00Z', now)).toBe('expired');
  });
});
