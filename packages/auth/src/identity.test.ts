import { describe, expect, it } from 'bun:test';
import {
  displayEmail,
  groupsFromClaim,
  invitePlaceholderEmail,
  isLinkInviteEmail,
  isPlaceholderEmail,
  mapGroups,
  readCookie,
  usernamePlaceholderEmail,
} from './identity';
import { idpPlaceholderEmail } from './identity-idp';

describe('placeholder emails (email is optional)', () => {
  it('builds stable, reserved-TLD addresses', () => {
    expect(usernamePlaceholderEmail('Alice')).toBe('alice@user.swarmy.invalid');
    expect(idpPlaceholderEmail('keycloak', 'f:1234|x')).toBe('c5fa10be4b205805e7e4d56993ae6071@keycloak.idp.swarmy.invalid');
    expect(idpPlaceholderEmail('keycloak', 'f:1234|x')).toBe(idpPlaceholderEmail('keycloak', 'f:1234|x'));
    expect(invitePlaceholderEmail('AbC123')).toBe('invite-abc123@invite.swarmy.invalid');
  });
  it('IdP placeholders never collide where sanitising the inputs would', () => {
    const addrs = [
      idpPlaceholderEmail('acme.corp', 'u1'),
      idpPlaceholderEmail('acme_corp', 'u1'),
      idpPlaceholderEmail('kc', 'a:1'),
      idpPlaceholderEmail('kc', 'a-1'),
      idpPlaceholderEmail('kc', 'A-1'),
      // The JSON pair keeps the provider/subject boundary unambiguous.
      idpPlaceholderEmail('a', 'b","c'),
      idpPlaceholderEmail('a","b', 'c'),
    ];
    expect(new Set(addrs).size).toBe(addrs.length);
    for (const a of addrs) expect(isPlaceholderEmail(a)).toBe(true);
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
