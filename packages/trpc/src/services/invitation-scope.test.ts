import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { acceptInvitation } from './invitation-accept';
import { resendInvitation } from './invitation-resend';
import { inviteMember, regenerateInvitation } from './invitations.service';

interface Inv {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  inviterId: string;
  stackName: string | null;
}

const HOUR = 3_600_000;
const inviter = { id: 'u1', name: 'Ada', email: 'ada@example.com' };
const matches = (row: object, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'gt' in v ? (row as Record<string, Date>)[k]! > (v.gt as Date) : (row as Record<string, unknown>)[k] === v));

/** Better Auth + Prisma in memory: invitations, members, grants, audit rows. No swarm (no nodes). */
function fake(invitations: Inv[] = []) {
  const members: Array<{ id: string; organizationId: string; userId: string; role: string }> = [];
  const grants: Array<Record<string, string>> = [];
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  let seq = 0;
  const db = {
    node: { count: async () => 0 },
    organization: { findUnique: async () => ({ name: 'Acme' }) },
    member: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        'user' in where ? null : (members.find((m) => matches(m, where)) ?? null),
      create: async ({ data }: { data: (typeof members)[number] }) => void members.push(data),
    },
    invitation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = invitations.find((i) => matches(i, where));
        return row ? { ...row, inviter } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Inv> }) => Object.assign(invitations.find((i) => i.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Inv> }) => {
        const row = invitations.find((i) => matches(i, where));
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    resourceGrant: { upsert: async ({ create }: { create: Record<string, string> }) => (grants.push(create), { id: 'g1', ...create }) },
    auditLog: { create: async ({ data }: { data: (typeof audits)[number] }) => void audits.push(data) },
  };
  const auth = {
    api: {
      setActiveOrganization: async () => ({}),
      createInvitation: async ({ body }: { body: { email: string; role: string; organizationId: string } }) => {
        const row: Inv = { id: `inv-${++seq}`, ...body, status: 'pending', expiresAt: new Date(Date.now() + 7 * 24 * HOUR), createdAt: new Date(), inviterId: inviter.id, stackName: null };
        invitations.push(row);
        return row;
      },
    },
  };
  const ctx = {
    db,
    auth,
    hub: { liveInventory: () => ({ services: [], containers: [] }) },
    activeOrgId: 'org1',
    user: inviter,
    membership: { role: 'owner', orgId: 'org1' },
    reqHeaders: new Headers({ origin: 'https://swarmy.example.com' }),
  } as unknown as OrgContext;
  return { ctx, db, invitations, members, grants, audits };
}

describe('app-scoped email invites (members.invite { stackName })', () => {
  it('stores the app on the invitation, shows it, and records it in the audit row', async () => {
    const f = fake();
    const view = await inviteMember(f.ctx, { email: 'bob@example.com', role: 'member', stackName: ' storefront ' });
    expect(view.stackName).toBe('storefront');
    expect(f.invitations[0]!.stackName).toBe('storefront');
    expect(f.audits[0]).toMatchObject({ action: 'member.invite', metadata: { stackName: 'storefront' } });
  });

  it('refuses an app on an admin or owner invite (they already reach every app)', async () => {
    const f = fake();
    await expect(inviteMember(f.ctx, { email: 'bob@example.com', role: 'admin', stackName: 'storefront' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.invitations).toHaveLength(0);
  });

  it('a whole-org invite stays unscoped, and regenerating keeps the app', async () => {
    const f = fake();
    expect((await inviteMember(f.ctx, { email: null, role: 'member' })).stackName).toBeNull();
    const scoped = await inviteMember(f.ctx, { email: 'bob@example.com', role: 'member', stackName: 'blog' });
    expect((await regenerateInvitation(f.ctx, scoped.id)).stackName).toBe('blog');
  });

  it('accepting it makes a member with operator on that app — the grant an invite link gives', async () => {
    const f = fake();
    const view = await inviteMember(f.ctx, { email: null, role: 'member', stackName: 'storefront' });
    const joiner = { ...f.ctx, user: { id: 'u2', email: 'new@user.swarmy.invalid', emailVerified: false } };
    expect(await acceptInvitation(joiner as never, view.id)).toEqual({ orgId: 'org1' });
    expect(f.members).toEqual([expect.objectContaining({ userId: 'u2', role: 'member' })]);
    expect(f.grants).toEqual([
      { orgId: 'org1', principalType: 'member', principalId: f.members[0]!.id, resourceType: 'stack', resourceId: 'storefront', relation: 'operator' },
    ]);
    // A second click is idempotent and grants nothing new.
    await acceptInvitation(joiner as never, view.id);
    expect(f.grants).toHaveLength(1);
  });
});

describe('members.resendInvitation', () => {
  it('mails a live email invite again with the same link (emailed: false when email is off)', async () => {
    const f = fake();
    const first = await inviteMember(f.ctx, { email: 'bob@example.com', role: 'member' });
    const again = await resendInvitation(f.ctx, first.id);
    expect(again).toMatchObject({ id: first.id, link: first.link, emailed: false });
    expect(f.audits.at(-1)).toMatchObject({ action: 'member.invite.resend', metadata: { email: 'bob@example.com', emailed: false } });
  });

  it('an expired invite is regenerated (fresh link) rather than resent', async () => {
    const f = fake();
    const first = await inviteMember(f.ctx, { email: 'bob@example.com', role: 'member', stackName: 'blog' });
    f.invitations[0]!.expiresAt = new Date(Date.now() - HOUR);
    const again = await resendInvitation(f.ctx, first.id);
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ status: 'pending', stackName: 'blog' });
    expect(f.invitations[0]!.status).toBe('canceled');
  });

  it('a link-only invite has no address to send to', async () => {
    const f = fake();
    const link = await inviteMember(f.ctx, { email: null, role: 'member' });
    await expect(resendInvitation(f.ctx, link.id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
