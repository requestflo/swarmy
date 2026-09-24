import { describe, expect, it } from 'bun:test';
import {
  displayEmail,
  groupsFromClaim,
  idpPlaceholderEmail,
  invitePlaceholderEmail,
  isLinkInviteEmail,
  isPlaceholderEmail,
  mapGroups,
  readCookie,
  usernamePlaceholderEmail,
} from './identity';

describe('placeholder emails (email is optional)', () => {
  it('builds stable, reserved-TLD addresses', () => {
    expect(usernamePlaceholderEmail('Alice')).toBe('alice@user.swarmy.invalid');
    expect(idpPlaceholderEmail('keycloak', 'f:1234|x')).toBe('f-1234-x@keycloak.sso.swarmy.invalid');
    expect(invitePlaceholderEmail('AbC123')).toBe('invite-abc123@invite.swarmy.invalid');
  });
  it('recognises placeholders and hides them from people', () => {
    expect(isPlaceholderEmail('alice@user.swarmy.invalid')).toBe(true);
    expect(isPlaceholderEmail('alice@example.com')).toBe(false);
    expect(isLinkInviteEmail(invitePlaceholderEmail('t'))).toBe(true);
    expect(isLinkInviteEmail('alice@user.swarmy.invalid')).toBe(false);
    expect(displayEmail('alice@user.swarmy.invalid')).toBeNull();
    expect(displayEmail('a@b.io')).toBe('a@b.io');
  });
});

describe('SSO group claims', () => {
  it('reads arrays, delimited strings and dotted paths; strips Keycloak slashes', () => {
    expect(groupsFromClaim({ groups: ['/devs', 'ops', 'ops'] }, 'groups')).toEqual(['devs', 'ops']);
    expect(groupsFromClaim({ roles: 'a, b c' }, 'roles')).toEqual(['a', 'b', 'c']);
    expect(groupsFromClaim({ realm_access: { roles: ['admin'] } }, 'realm_access.roles')).toEqual(['admin']);
    expect(groupsFromClaim({}, 'groups')).toEqual([]);
  });
  it('passes names through without a map, and allow-lists with one', () => {
    expect(mapGroups(['devs', 'x'], {})).toEqual(['devs', 'x']);
    expect(mapGroups(['devs', 'x', 'sre'], { devs: 'developers', sre: 'ops,oncall' })).toEqual([
      'developers',
      'ops',
      'oncall',
    ]);
  });
});

describe('readCookie', () => {
  it('finds a named cookie', () => {
    expect(readCookie('a=1; swarmy_invite=inv%5F1; b=2', 'swarmy_invite')).toBe('inv_1');
    expect(readCookie('a=1', 'swarmy_invite')).toBeNull();
    expect(readCookie(null, 'x')).toBeNull();
  });
});
