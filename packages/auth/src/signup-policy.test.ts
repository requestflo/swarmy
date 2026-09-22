import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import { buildAuth } from './server';
import {
  assertSignupAllowed,
  canCreateOrganization,
  INVITE_ONLY_MESSAGE,
  isSignupAllowed,
  resolveSignupMode,
  type SignupPolicyDb,
} from './signup-policy';

interface FakeState {
  users?: number;
  orgs?: number;
  invites?: { email: string; status: string; expiresAt: Date }[];
  owners?: string[];
}

function fakeDb(s: FakeState): SignupPolicyDb {
  return {
    user: { count: async () => s.users ?? 0 },
    organization: { count: async () => s.orgs ?? 0 },
    invitation: {
      findFirst: async ({ where }: { where: { email: string; status: string; expiresAt: { gt: Date } } }) => {
        const hit = (s.invites ?? []).find(
          (i) => i.email === where.email && i.status === where.status && i.expiresAt > where.expiresAt.gt,
        );
        return hit ? { id: 'inv_1' } : null;
      },
    },
    member: {
      findFirst: async ({ where }: { where: { userId: string; role: string } }) =>
        where.role === 'owner' && (s.owners ?? []).includes(where.userId) ? { id: 'm_1' } : null,
    },
  } as unknown as SignupPolicyDb;
}

const PROD = { NODE_ENV: 'production' };
const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 1_000);

describe('resolveSignupMode', () => {
  it('defaults to invite-only in production and open in dev', () => {
    expect(resolveSignupMode(PROD)).toBe('invite-only');
    expect(resolveSignupMode({ NODE_ENV: 'development' })).toBe('open');
    expect(resolveSignupMode({})).toBe('open');
  });
  it('honours an explicit SWARMY_ALLOW_SIGNUP either way', () => {
    expect(resolveSignupMode({ ...PROD, SWARMY_ALLOW_SIGNUP: 'true' })).toBe('open');
    expect(resolveSignupMode({ NODE_ENV: 'development', SWARMY_ALLOW_SIGNUP: 'false' })).toBe('invite-only');
  });
});

describe('isSignupAllowed', () => {
  it('refuses a stranger when invite-only and no invite exists', async () => {
    expect(await isSignupAllowed(fakeDb({ users: 1 }), 'eve@evil.test', PROD)).toBe(false);
    await expect(assertSignupAllowed(fakeDb({ users: 1 }), 'eve@evil.test', PROD)).rejects.toThrow(
      INVITE_ONLY_MESSAGE,
    );
  });

  it('allows an email with a pending, unexpired invitation (case-insensitive)', async () => {
    const db = fakeDb({ users: 1, invites: [{ email: 'bob@team.test', status: 'pending', expiresAt: future }] });
    expect(await isSignupAllowed(db, 'Bob@Team.test', PROD)).toBe(true);
  });

  it('refuses expired or already-accepted invitations', async () => {
    const db = fakeDb({
      users: 1,
      invites: [
        { email: 'old@team.test', status: 'pending', expiresAt: past },
        { email: 'done@team.test', status: 'accepted', expiresAt: future },
      ],
    });
    expect(await isSignupAllowed(db, 'old@team.test', PROD)).toBe(false);
    expect(await isSignupAllowed(db, 'done@team.test', PROD)).toBe(false);
  });

  it('allows anyone when registration is open', async () => {
    expect(await isSignupAllowed(fakeDb({ users: 5 }), 'x@y.test', { ...PROD, SWARMY_ALLOW_SIGNUP: 'true' })).toBe(true);
  });

  it('allows the first user (first-run bootstrap)', async () => {
    expect(await isSignupAllowed(fakeDb({ users: 0 }), 'owner@x.test', PROD)).toBe(true);
  });

  it('allows the installer seed to create ADMIN_EMAIL under SWARMY_BOOTSTRAP=1', async () => {
    const env = { ...PROD, SWARMY_BOOTSTRAP: '1', ADMIN_EMAIL: 'Owner@x.test' };
    expect(await isSignupAllowed(fakeDb({ users: 3 }), 'owner@x.test', env)).toBe(true);
    expect(await isSignupAllowed(fakeDb({ users: 3 }), 'other@x.test', env)).toBe(false);
  });
});

describe('canCreateOrganization', () => {
  it('refuses a user with no org when invite-only', async () => {
    expect(await canCreateOrganization(fakeDb({ orgs: 1 }), 'u_stranger', PROD)).toBe(false);
  });
  it('allows the first org on a fresh controller', async () => {
    expect(await canCreateOrganization(fakeDb({ orgs: 0 }), 'u_first', PROD)).toBe(true);
  });
  it('allows an instance admin (owner of an existing org)', async () => {
    expect(await canCreateOrganization(fakeDb({ orgs: 1, owners: ['u_owner'] }), 'u_owner', PROD)).toBe(true);
  });
  it('allows anyone when registration is open', async () => {
    expect(await canCreateOrganization(fakeDb({ orgs: 1 }), 'u_x', { ...PROD, SWARMY_ALLOW_SIGNUP: 'true' })).toBe(true);
  });
});

describe('buildAuth wiring', () => {
  it('runs the policy in the user.create.before hook and gates org creation', async () => {
    const prev = { ...process.env };
    process.env.NODE_ENV = 'production';
    delete process.env.SWARMY_ALLOW_SIGNUP;
    try {
      const db = fakeDb({ users: 1, orgs: 1 }) as unknown as DB;
      const ctx = await buildAuth(undefined, { db }).$context;
      const before = ctx.options.databaseHooks?.user?.create?.before;
      expect(before).toBeDefined();
      await expect(
        before!({ id: 'u', email: 'eve@evil.test', name: 'eve', emailVerified: false, createdAt: new Date(), updatedAt: new Date() }),
      ).rejects.toThrow(INVITE_ONLY_MESSAGE);

      const org = ctx.options.plugins?.find((p) => p.id === 'organization') as
        | { options?: { allowUserToCreateOrganization?: (u: { id: string }) => Promise<boolean> } }
        | undefined;
      expect(await org?.options?.allowUserToCreateOrganization?.({ id: 'u_stranger' })).toBe(false);
    } finally {
      process.env = prev;
    }
  });
});
