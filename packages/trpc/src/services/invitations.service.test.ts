import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import {
  inviteLink,
  inviteLinkBase,
  inviteMember,
  listInvitations,
  regenerateInvitation,
  revokeInvitation,
} from './invitations.service';

interface FakeInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  inviterId: string;
}

interface Fake {
  ctx: OrgContext;
  invitations: FakeInvitation[];
  audits: Array<{ action: string; targetId: string | null; metadata: Record<string, unknown> }>;
  createCalls: Array<{ email: string; role: string; organizationId: string }>;
}

const HOUR = 3_600_000;
const inviter = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

function fakeCtx(opts: { members?: string[]; invitations?: FakeInvitation[]; headers?: Headers } = {}): Fake {
  const invitations = opts.invitations ?? [];
  const members = new Set(opts.members ?? []);
  const audits: Fake['audits'] = [];
  const createCalls: Fake['createCalls'] = [];
  let seq = 0;

  const db = {
    member: {
      findFirst: async ({ where }: { where: { user: { email: string } } }) =>
        members.has(where.user.email) ? { id: 'm1' } : null,
    },
    invitation: {
      findFirst: async ({
        where,
      }: {
        where: { id?: string; email?: string; status: string; expiresAt?: { gt: Date } };
      }) =>
        invitations.find(
          (i) =>
            i.organizationId === 'org1' &&
            i.status === where.status &&
            (where.id === undefined || i.id === where.id) &&
            (where.email === undefined || i.email === where.email) &&
            (where.expiresAt === undefined || i.expiresAt > where.expiresAt.gt),
        ) ?? null,
      findMany: async () =>
        invitations
          .filter((i) => i.organizationId === 'org1' && i.status === 'pending')
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((i) => ({ ...i, inviter })),
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        const row = invitations.find((i) => i.id === where.id)!;
        row.status = data.status;
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string; targetId: string | null; metadata: Record<string, unknown> } }) => {
        audits.push({ action: data.action, targetId: data.targetId, metadata: data.metadata });
        return data;
      },
    },
  };

  const auth = {
    api: {
      createInvitation: async ({ body }: { body: { email: string; role: string; organizationId: string } }) => {
        createCalls.push(body);
        const row: FakeInvitation = {
          id: `inv-${++seq}`,
          organizationId: body.organizationId,
          email: body.email,
          role: body.role,
          status: 'pending',
          expiresAt: new Date(Date.now() + 48 * HOUR),
          createdAt: new Date(),
          inviterId: inviter.id,
        };
        invitations.push(row);
        return row;
      },
    },
  };

  const ctx = {
    db,
    auth,
    activeOrgId: 'org1',
    user: inviter,
    membership: { role: 'owner', orgId: 'org1' },
    reqHeaders: opts.headers ?? new Headers({ origin: 'https://swarmy.example.com' }),
  } as unknown as OrgContext;
  return { ctx, invitations, audits, createCalls };
}

function pendingRow(id: string, email: string, ageHours = 1, ttlHours = 47): FakeInvitation {
  return {
    id,
    organizationId: 'org1',
    email,
    role: 'member',
    status: 'pending',
    expiresAt: new Date(Date.now() + ttlHours * HOUR),
    createdAt: new Date(Date.now() - ageHours * HOUR),
    inviterId: inviter.id,
  };
}

describe('inviteLinkBase', () => {
  it('uses CONTROLLER_PUBLIC_URL when it is a real address', () => {
    const base = inviteLinkBase(new Headers({ origin: 'http://localhost:3023' }), {
      CONTROLLER_PUBLIC_URL: 'https://swarmy.example.com',
    });
    expect(base).toBe('https://swarmy.example.com');
  });

  it('falls back to the request origin when only loopback is known', () => {
    const base = inviteLinkBase(new Headers({ origin: 'http://localhost:3023', host: 'localhost:3021' }), {
      CONTROLLER_PUBLIC_URL: 'http://localhost:3021',
    });
    expect(base).toBe('http://localhost:3023');
  });

  it('builds the login link with the invitation id', () => {
    expect(inviteLink('https://s.example.com', 'abc 1')).toBe('https://s.example.com/login?invite=abc%201');
  });
});

describe('inviteMember', () => {
  it('creates a Better Auth invitation for the org and returns the link + audit row', async () => {
    const f = fakeCtx();
    const view = await inviteMember(f.ctx, { email: 'Bob@Example.com', role: 'admin' });
    expect(f.createCalls).toEqual([{ email: 'bob@example.com', role: 'admin', organizationId: 'org1' }]);
    expect(view.id).toBe('inv-1');
    expect(view.status).toBe('pending');
    expect(view.link).toBe('https://swarmy.example.com/login?invite=inv-1');
    expect(view.invitedBy?.id).toBe('u1');
    expect(f.audits).toEqual([
      expect.objectContaining({ action: 'member.invite', targetId: 'inv-1', metadata: expect.objectContaining({ email: 'bob@example.com', role: 'admin' }) }),
    ]);
  });

  it('refuses an email that is already a member', async () => {
    const f = fakeCtx({ members: ['bob@example.com'] });
    await expect(inviteMember(f.ctx, { email: 'bob@example.com', role: 'member' })).rejects.toThrow(/already a member/);
    expect(f.createCalls).toHaveLength(0);
    expect(f.audits).toHaveLength(0);
  });

  it('refuses a duplicate while a pending invite is still live', async () => {
    const f = fakeCtx({ invitations: [pendingRow('inv-0', 'bob@example.com')] });
    await expect(inviteMember(f.ctx, { email: 'bob@example.com', role: 'member' })).rejects.toThrow(/pending invite/);
  });

  it('allows a re-invite once the previous one has expired', async () => {
    const f = fakeCtx({ invitations: [pendingRow('inv-0', 'bob@example.com', 60, -1)] });
    const view = await inviteMember(f.ctx, { email: 'bob@example.com', role: 'member' });
    expect(view.id).toBe('inv-1');
  });

  it('surfaces a Better Auth refusal as a BAD_REQUEST with its message', async () => {
    const f = fakeCtx();
    (f.ctx.auth.api as unknown as { createInvitation: () => Promise<never> }).createInvitation = async () => {
      throw Object.assign(new Error('x'), { body: { message: 'You are not allowed to invite user with this role' } });
    };
    await expect(inviteMember(f.ctx, { email: 'bob@example.com', role: 'owner' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'You are not allowed to invite user with this role',
    });
  });
});

describe('listInvitations', () => {
  it('lists pending rows newest first and flags expired ones', async () => {
    const f = fakeCtx({
      invitations: [
        pendingRow('old', 'old@example.com', 100, -1),
        pendingRow('new', 'new@example.com', 1),
        { ...pendingRow('done', 'done@example.com'), status: 'accepted' },
      ],
    });
    const rows = await listInvitations(f.ctx);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[1]!.status).toBe('expired');
    expect(rows[0]!.link).toBe('https://swarmy.example.com/login?invite=new');
  });
});

describe('revokeInvitation', () => {
  it('cancels a pending invitation and audits it', async () => {
    const f = fakeCtx({ invitations: [pendingRow('inv-0', 'bob@example.com')] });
    const res = await revokeInvitation(f.ctx, 'inv-0');
    expect(res).toEqual({ id: 'inv-0', revoked: true });
    expect(f.invitations[0]!.status).toBe('canceled');
    expect(f.audits).toEqual([expect.objectContaining({ action: 'member.invite.revoke', targetId: 'inv-0' })]);
  });

  it('404s for an unknown or already-cancelled id', async () => {
    const f = fakeCtx({ invitations: [{ ...pendingRow('inv-0', 'bob@example.com'), status: 'canceled' }] });
    await expect(revokeInvitation(f.ctx, 'inv-0')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(revokeInvitation(f.ctx, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('regenerateInvitation', () => {
  it('cancels the old row and mints a new id for the same email + role', async () => {
    const f = fakeCtx({ invitations: [{ ...pendingRow('inv-0', 'bob@example.com', 60, -1), role: 'admin' }] });
    const view = await regenerateInvitation(f.ctx, 'inv-0');
    expect(f.invitations[0]!.status).toBe('canceled');
    expect(view.id).toBe('inv-1');
    expect(view.role).toBe('admin');
    expect(view.status).toBe('pending');
    expect(f.createCalls).toEqual([{ email: 'bob@example.com', role: 'admin', organizationId: 'org1' }]);
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'member.invite.regenerate',
        targetId: 'inv-1',
        metadata: expect.objectContaining({ replaced: 'inv-0' }),
      }),
    ]);
  });
});
