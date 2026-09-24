import { describe, expect, it } from 'bun:test';
import {
  assertAccountLinkAllowed,
  decideAccountLink,
  isReservedProviderId,
  NEW_USER_WINDOW_MS,
  userLooksNew,
} from './account-linking';

const NOW = new Date('2026-09-24T12:00:00Z');

describe('decideAccountLink (an org SSO IdP never links onto a stranger)', () => {
  it('always allows non-SSO providers (credential, social)', () => {
    expect(decideAccountLink({ ssoOrgId: null, userIsNew: false, isMemberOfSsoOrg: false })).toEqual({ allow: true });
  });
  it("allows the SSO provider's first login (new user) and its own org's members", () => {
    expect(decideAccountLink({ ssoOrgId: 'org_b', userIsNew: true, isMemberOfSsoOrg: false }).allow).toBe(true);
    expect(decideAccountLink({ ssoOrgId: 'org_b', userIsNew: false, isMemberOfSsoOrg: true }).allow).toBe(true);
  });
  it("refuses linking an existing non-member (org A's owner) to org B's IdP", () => {
    expect(decideAccountLink({ ssoOrgId: 'org_b', userIsNew: false, isMemberOfSsoOrg: false })).toEqual({
      allow: false,
      reason: 'sso_link_not_member',
    });
  });
});

describe('userLooksNew', () => {
  it('a row not yet visible, or one created moments ago with no accounts, is new', () => {
    expect(userLooksNew(null, 0, NOW)).toBe(true);
    expect(userLooksNew({ createdAt: new Date(NOW.getTime() - 1_000) }, 0, NOW)).toBe(true);
  });
  it('a user with any account, or created earlier, is pre-existing', () => {
    expect(userLooksNew({ createdAt: new Date(NOW.getTime() - 1_000) }, 1, NOW)).toBe(false);
    expect(userLooksNew({ createdAt: new Date(NOW.getTime() - NEW_USER_WINDOW_MS - 1) }, 0, NOW)).toBe(false);
  });
});

describe('isReservedProviderId', () => {
  it('reserves built-in and social provider ids', () => {
    for (const id of ['credential', 'google', 'github', 'microsoft', 'gitlab', 'passkey', 'GitHub']) {
      expect(isReservedProviderId(id)).toBe(true);
    }
    expect(isReservedProviderId('acme-keycloak')).toBe(false);
  });
});

describe('assertAccountLinkAllowed (account.create.before)', () => {
  const db = (s: { sso?: Record<string, string>; members?: Array<[string, string]>; accounts?: number; createdAt?: Date }) =>
    ({
      ssoProvider: {
        findUnique: async ({ where }: { where: { providerId: string } }) =>
          s.sso?.[where.providerId] ? { orgId: s.sso[where.providerId] } : null,
      },
      user: { findUnique: async () => ({ createdAt: s.createdAt ?? new Date(NOW.getTime() - 86_400_000) }) },
      account: { count: async () => s.accounts ?? 1 },
      member: {
        findFirst: async ({ where }: { where: { userId: string; organizationId: string } }) =>
          (s.members ?? []).some(([u, o]) => u === where.userId && o === where.organizationId) ? { id: 'm' } : null,
      },
    }) as never;

  it("throws when org B's IdP would link onto org A's owner", async () => {
    const d = db({ sso: { rogue: 'org_b' }, members: [['owner_a', 'org_a']] });
    await expect(assertAccountLinkAllowed(d, { userId: 'owner_a', providerId: 'rogue' }, NOW)).rejects.toThrow(
      /not a member/,
    );
  });
  it('passes social links, own-org members and brand-new users', async () => {
    const d = db({ sso: { kc: 'org_a' }, members: [['ann', 'org_a']] });
    await assertAccountLinkAllowed(d, { userId: 'owner_a', providerId: 'google' }, NOW);
    await assertAccountLinkAllowed(d, { userId: 'ann', providerId: 'kc' }, NOW);
    const fresh = db({ sso: { kc: 'org_a' }, accounts: 0, createdAt: new Date(NOW.getTime() - 500) });
    await assertAccountLinkAllowed(fresh, { userId: 'newbie', providerId: 'kc' }, NOW);
  });
});
