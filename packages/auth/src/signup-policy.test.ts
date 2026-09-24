import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import { buildAuth } from './server';
import {
  assertSignupAllowed,
  canCreateOrganization,
  INVITE_ONLY_MESSAGE,
  emailDomainAllowed,
  isSignupAllowed,
  parseAllowedDomains,
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
        return hit ? { id: 'inv_1', email: hit.email, organizationId: 'org_a' } : null;
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

  it('allows a proven email with a pending, unexpired invitation (case-insensitive)', async () => {
    const db = fakeDb({ users: 1, invites: [{ email: 'bob@team.test', status: 'pending', expiresAt: future }] });
    expect(await isSignupAllowed(db, 'Bob@Team.test', PROD, new Date(), { emailVerified: true })).toBe(true);
    // The inviting org's own SSO directory carrying the address is proof.
    expect(await isSignupAllowed(db, 'Bob@Team.test', PROD, new Date(), { idpOrgId: 'org_a' })).toBe(true);
    // A typed-in, unverified address is not proof.
    expect(await isSignupAllowed(db, 'Bob@Team.test', PROD)).toBe(false);
    // Nor is another org's SSO provider asserting an unverified address.
    expect(await isSignupAllowed(db, 'Bob@Team.test', PROD, new Date(), { idpOrgId: 'org_rogue' })).toBe(false);
  });

  it('refuses expired or already-accepted invitations', async () => {
    const db = fakeDb({
      users: 1,
      invites: [
        { email: 'old@team.test', status: 'pending', expiresAt: past },
        { email: 'done@team.test', status: 'accepted', expiresAt: future },
      ],
    });
    expect(await isSignupAllowed(db, 'old@team.test', PROD, new Date(), { emailVerified: true })).toBe(false);
    expect(await isSignupAllowed(db, 'done@team.test', PROD, new Date(), { emailVerified: true })).toBe(false);
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

describe('isSignupAllowed — invite links, SSO and username bootstrap', () => {
  const linkDb = (extra: Record<string, unknown> = {}) =>
    ({
      ...fakeDb({ users: 1 }),
      invitation: {
        findFirst: async ({ where }: { where: { id?: string; email?: string } }) =>
          where.id === 'inv_link' ? { id: 'inv_link', email: 'invite-l@invite.swarmy.invalid' } : null,
      },
      ...extra,
    }) as unknown as SignupPolicyDb;

  it('admits any address when the request holds a pending link-only invite', async () => {
    expect(await isSignupAllowed(linkDb(), 'alice@user.swarmy.invalid', PROD, new Date(), { inviteId: 'inv_link' })).toBe(true);
    expect(await isSignupAllowed(linkDb(), 'alice@user.swarmy.invalid', PROD, new Date(), { inviteId: 'nope' })).toBe(false);
  });

  it('an email-named invite admits only that proven address', async () => {
    const db = linkDb({
      invitation: {
        findFirst: async ({ where }: { where: { id?: string; email?: string } }) =>
          where.id === 'inv_ann' || where.email === 'ann@corp.io' ? { email: 'ann@corp.io', organizationId: 'org_a' } : null,
      },
    });
    const at = new Date();
    expect(await isSignupAllowed(db, 'eve@x.io', PROD, at, { inviteId: 'inv_ann', emailVerified: true })).toBe(false);
    expect(await isSignupAllowed(db, 'ann@corp.io', PROD, at, { inviteId: 'inv_ann' })).toBe(false);
    expect(await isSignupAllowed(db, 'ann@corp.io', PROD, at, {})).toBe(false);
    expect(await isSignupAllowed(db, 'ann@corp.io', PROD, at, { idpOrgId: 'org_a' })).toBe(true);
    expect(await isSignupAllowed(db, 'ann@corp.io', PROD, at, { inviteId: 'inv_ann', idpOrgId: 'org_b' })).toBe(false);
    expect(await isSignupAllowed(db, 'ann@corp.io', PROD, at, { inviteId: 'inv_ann', emailVerified: true })).toBe(true);
  });

  it('admits a social sign-up from an allowed domain', async () => {
    expect(await isSignupAllowed(linkDb(), 'bob@company.com', PROD, new Date(), { socialDomainAllowed: true })).toBe(true);
  });

  it('admits an org SSO first login only when the provider auto-provisions', async () => {
    const sso = (metadata: Record<string, unknown>, enabled = true) => ({
      ssoProvider: { findUnique: async () => ({ enabled, metadata }) },
    });
    const via = { ssoProviderId: 'keycloak' };
    expect(await isSignupAllowed(linkDb(sso({})), 'bob@corp.test', PROD, new Date(), via)).toBe(true);
    expect(await isSignupAllowed(linkDb(sso({ autoProvision: false })), 'bob@corp.test', PROD, new Date(), via)).toBe(false);
    expect(await isSignupAllowed(linkDb(sso({}, false)), 'bob@corp.test', PROD, new Date(), via)).toBe(false);
  });

  it('lets the installer seed a no-email owner by ADMIN_USERNAME', async () => {
    const env = { ...PROD, SWARMY_BOOTSTRAP: '1', ADMIN_USERNAME: 'Root' };
    expect(await isSignupAllowed(linkDb(), 'root@user.swarmy.invalid', env, new Date(), { username: 'root' })).toBe(true);
    expect(await isSignupAllowed(linkDb(), 'root@user.swarmy.invalid', env, new Date(), { username: 'eve' })).toBe(false);
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
        before!(
          { id: 'u', email: 'eve@evil.test', name: 'eve', emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
          null,
        ),
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

describe('allowedDomains', () => {
  it('parses a setting and matches exact domains only', () => {
    const d = parseAllowedDomains(' @Company.com, corp.io  nonsense ');
    expect(d).toEqual(['company.com', 'corp.io']);
    expect(emailDomainAllowed('a@company.com', d)).toBe(true);
    expect(emailDomainAllowed('a@evil.company.com', d)).toBe(false);
    expect(emailDomainAllowed('a@company.com', [])).toBe(false);
  });
});
