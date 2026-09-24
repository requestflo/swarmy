import { describe, expect, it } from 'bun:test';
import {
  provisionDomainMember,
  provisionSsoMember,
  redeemInvitation,
  ssoProfileMapper,
  ssoProviderIdFromPath,
  takeSsoGroups,
} from './provisioning';

interface Row {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  attributes?: Record<string, unknown>;
}

function fakeDb(init: {
  members?: Row[];
  invites?: Array<{ id: string; organizationId: string; role: string; email: string; status: string; expiresAt: Date }>;
  /** The user's non-credential accounts (provider ids). */
  accounts?: string[];
  /** Org SSO providers: providerId → orgId. */
  sso?: Record<string, string>;
}) {
  const members = [...(init.members ?? [])];
  const invites = [...(init.invites ?? [])];
  const audit: string[] = [];
  const db = {
    member: {
      findFirst: async ({ where }: { where: { organizationId?: string; userId: string } }) =>
        members.find(
          (m) => (where.organizationId === undefined || m.organizationId === where.organizationId) && m.userId === where.userId,
        ) ?? null,
      create: async ({ data }: { data: Row }) => void members.push(data),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(members.find((m) => m.id === where.id)!, data),
    },
    invitation: {
      findFirst: async ({ where }: { where: { id: string; status: string; expiresAt: { gt: Date } } }) =>
        invites.find((i) => i.id === where.id && i.status === where.status && i.expiresAt > where.expiresAt.gt) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
        const row = invites.find((i) => i.id === where.id && i.status === where.status);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    account: {
      findFirst: async ({ where }: { where: { providerId: { in: string[] } } }) =>
        (init.accounts ?? []).some((p) => where.providerId.in.includes(p)) ? { id: 'acc' } : null,
    },
    ssoProvider: {
      findMany: async ({ where }: { where: { orgId: string } }) =>
        Object.entries(init.sso ?? {})
          .filter(([, org]) => org === where.orgId)
          .map(([providerId]) => ({ providerId })),
    },
    organization: { findFirst: async () => ({ id: 'org-1' }) },
    session: { updateMany: async () => ({ count: 1 }) },
  };
  const sink = async (_org: string, e: { action: string }) => void audit.push(e.action);
  return { db: db as never, members, invites, audit, sink };
}

const future = new Date(Date.now() + 86_400_000);

describe('redeemInvitation (single-use; email invites need a proven address)', () => {
  const u1 = { id: 'u1', email: 'u1@user.swarmy.invalid' };
  const inv = (email: string, role = 'admin') => ({
    id: 'inv', organizationId: 'org', role, email, status: 'pending', expiresAt: future,
  });

  it('a link-only invite admits whoever holds it, once', async () => {
    const f = fakeDb({ invites: [inv('invite-x@invite.swarmy.invalid')] });
    expect(await redeemInvitation(f.db, { invitationId: 'inv', user: u1 }, f.sink)).toEqual({ ok: true, orgId: 'org', role: 'admin' });
    expect(f.members[0]).toMatchObject({ userId: 'u1', role: 'admin' });
    expect(f.invites[0]!.status).toBe('accepted');
    expect(await redeemInvitation(f.db, { invitationId: 'inv', user: u1 }, f.sink)).toEqual({ ok: false, reason: 'gone' });
    expect(f.audit).toEqual(['member.invite.accept']);
  });

  it('an email invite refuses a different or unverified address', async () => {
    const f = fakeDb({ invites: [inv('ann@corp.io')] });
    const other = await redeemInvitation(f.db, { invitationId: 'inv', user: { id: 'u', email: 'eve@x.io', emailVerified: true } });
    expect(other).toEqual({ ok: false, reason: 'email_mismatch', invitedEmail: 'ann@corp.io' });
    const unverified = await redeemInvitation(f.db, { invitationId: 'inv', user: { id: 'u', email: 'ann@corp.io' } });
    expect(unverified.ok).toBe(false);
    expect(f.members).toHaveLength(0);
    expect(f.invites[0]!.status).toBe('pending');
  });

  it('an email invite admits the verified address, or the inviting org\'s own SSO identity carrying it', async () => {
    const verified = fakeDb({ invites: [inv('ann@corp.io')] });
    expect((await redeemInvitation(verified.db, { invitationId: 'inv', user: { id: 'u', email: 'ANN@corp.io', emailVerified: true } })).ok).toBe(true);
    const idp = fakeDb({ invites: [inv('ann@corp.io')], accounts: ['kc'], sso: { kc: 'org' } });
    expect((await redeemInvitation(idp.db, { invitationId: 'inv', user: { id: 'u', email: 'ann@corp.io' } })).ok).toBe(true);
  });

  it('an unverified address carried by a social or another org\'s SSO identity is not proof', async () => {
    const unverified = { id: 'u', email: 'ann@corp.io', emailVerified: false };
    const social = fakeDb({ invites: [inv('ann@corp.io')], accounts: ['github'], sso: { kc: 'org' } });
    expect(await redeemInvitation(social.db, { invitationId: 'inv', user: unverified })).toEqual({
      ok: false,
      reason: 'email_mismatch',
      invitedEmail: 'ann@corp.io',
    });
    const rogue = fakeDb({ invites: [inv('ann@corp.io')], accounts: ['rogue'], sso: { kc: 'org', rogue: 'org-evil' } });
    expect((await redeemInvitation(rogue.db, { invitationId: 'inv', user: unverified })).ok).toBe(false);
    expect(rogue.members).toHaveLength(0);
    expect(rogue.invites[0]!.status).toBe('pending');
  });

  it('refuses an expired invite', async () => {
    const f = fakeDb({ invites: [{ ...inv('invite-x@invite.swarmy.invalid'), expiresAt: new Date(Date.now() - 1) }] });
    expect((await redeemInvitation(f.db, { invitationId: 'inv', user: u1 })).ok).toBe(false);
  });
});

describe('provisionDomainMember (social allowedDomains)', () => {
  it('adds a newcomer to the controller org, and no-ops for existing members', async () => {
    const f = fakeDb({});
    expect(await provisionDomainMember(f.db, { userId: 'u', providerId: 'google' }, f.sink)).toEqual({ orgId: 'org-1' });
    expect(f.members[0]).toMatchObject({ organizationId: 'org-1', role: 'member' });
    expect(await provisionDomainMember(f.db, { userId: 'u', providerId: 'google' })).toBeNull();
  });
});

describe('provisionSsoMember', () => {
  const provider = { providerId: 'kc', orgId: 'org', autoProvision: true, defaultRole: 'member' as const };
  it('creates a member with SSO groups on first login', async () => {
    const f = fakeDb({});
    expect(await provisionSsoMember(f.db, { provider, userId: 'u', groups: ['devs'] }, f.sink)).toEqual({ orgId: 'org', created: true });
    expect(f.members[0]).toMatchObject({ role: 'member', attributes: { ssoGroups: ['devs'] } });
  });
  it('replaces ssoGroups but keeps admin-set attributes', async () => {
    const f = fakeDb({ members: [{ id: 'm', organizationId: 'org', userId: 'u', role: 'admin', attributes: { groups: ['manual'], ssoGroups: ['old'] } }] });
    await provisionSsoMember(f.db, { provider, userId: 'u', groups: ['new'] }, f.sink);
    expect(f.members[0]).toMatchObject({ role: 'admin', attributes: { groups: ['manual'], ssoGroups: ['new'] } });
    expect(f.audit).toEqual(['member.sso.groups']);
  });
  it('does not provision strangers when auto-provision is off', async () => {
    const f = fakeDb({});
    expect(await provisionSsoMember(f.db, { provider: { ...provider, autoProvision: false }, userId: 'u', groups: [] })).toBeNull();
    expect(f.members).toHaveLength(0);
  });
});

describe('ssoProfileMapper', () => {
  it('fills a placeholder email, applies the mapping and stashes mapped groups', () => {
    const map = ssoProfileMapper({
      providerId: 'kc',
      protocol: 'oidc',
      orgId: 'org',
      mapping: { name: 'display_name', groups: 'roles' },
      groupMap: { eng: 'developers' },
    });
    const out = map({ sub: 'abc', display_name: 'Ann', roles: ['eng', 'other'] });
    expect(out).toEqual({ name: 'Ann', email: 'abc@kc.sso.swarmy.invalid' });
    expect(takeSsoGroups('kc', 'abc@kc.sso.swarmy.invalid')).toEqual(['developers']);
    expect(takeSsoGroups('kc', 'abc@kc.sso.swarmy.invalid')).toBeNull();
  });
  it('keeps a real email untouched', () => {
    const map = ssoProfileMapper({ providerId: 'kc', protocol: 'oidc', orgId: 'org' });
    expect(map({ sub: 's', email: 'ann@corp.io', name: 'Ann', groups: ['a'] })).toEqual({});
    expect(takeSsoGroups('kc', 'ann@corp.io')).toEqual(['a']);
  });
});

describe('ssoProviderIdFromPath', () => {
  it('reads the provider from params or the path', () => {
    expect(ssoProviderIdFromPath('/oauth2/callback/:providerId', { providerId: 'kc' })).toBe('kc');
    expect(ssoProviderIdFromPath('/oauth2/callback/zitadel')).toBe('zitadel');
    expect(ssoProviderIdFromPath('/callback/github')).toBeNull();
  });
});
