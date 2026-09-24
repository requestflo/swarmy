import { describe, expect, it } from 'bun:test';
import {
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

function fakeDb(init: { members?: Row[]; invites?: Array<{ id: string; organizationId: string; role: string; email: string; status: string; expiresAt: Date }> }) {
  const members = [...(init.members ?? [])];
  const invites = [...(init.invites ?? [])];
  const audit: string[] = [];
  const db = {
    member: {
      findFirst: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        members.find((m) => m.organizationId === where.organizationId && m.userId === where.userId) ?? null,
      create: async ({ data }: { data: Row }) => void members.push(data),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(members.find((m) => m.id === where.id)!, data),
    },
    invitation: {
      findFirst: async ({ where }: { where: { id: string; status: string; expiresAt: { gt: Date } } }) =>
        invites.find((i) => i.id === where.id && i.status === where.status && i.expiresAt > where.expiresAt.gt) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) =>
        Object.assign(invites.find((i) => i.id === where.id)!, data),
    },
    session: { updateMany: async () => ({ count: 1 }) },
  };
  const sink = async (_org: string, e: { action: string }) => void audit.push(e.action);
  return { db: db as never, members, invites, audit, sink };
}

const future = new Date(Date.now() + 86_400_000);

describe('redeemInvitation (invite links are the credential)', () => {
  it('joins the invited org with the invited role, once', async () => {
    const f = fakeDb({
      invites: [{ id: 'inv', organizationId: 'org', role: 'admin', email: 'invite-x@invite.swarmy.invalid', status: 'pending', expiresAt: future }],
    });
    expect(await redeemInvitation(f.db, { invitationId: 'inv', userId: 'u1' }, f.sink)).toEqual({ orgId: 'org', role: 'admin' });
    expect(f.members).toHaveLength(1);
    expect(f.members[0]).toMatchObject({ userId: 'u1', role: 'admin' });
    expect(f.invites[0]!.status).toBe('accepted');
    expect(await redeemInvitation(f.db, { invitationId: 'inv', userId: 'u1' }, f.sink)).toBeNull();
    expect(f.audit).toEqual(['member.invite.accept']);
  });
  it('refuses an expired invite', async () => {
    const f = fakeDb({
      invites: [{ id: 'inv', organizationId: 'org', role: 'member', email: 'e', status: 'pending', expiresAt: new Date(Date.now() - 1) }],
    });
    expect(await redeemInvitation(f.db, { invitationId: 'inv', userId: 'u1' })).toBeNull();
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
