import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { acceptInvitation } from './invitation-accept';
import { acceptInviteLink, createInviteLink, inviteLinkPreview } from './inviteLinks.service';

// Invites that must be accepted with SSO, from the tRPC side: minting needs a
// ready provider, and accepting reads how the accepting session signed in.

let store: TestDb;
let db: DB;
const HOUR = 3_600_000;

function ctxFor(userId: string, opts: { role?: 'owner' | 'admin' | 'member'; email?: string } = {}): OrgContext {
  return {
    db,
    activeOrgId: 'org-a',
    session: { id: `s-${userId}` },
    user: { id: userId, email: opts.email ?? `${userId}@acme.test`, name: userId, emailVerified: true },
    membership: { role: opts.role ?? 'admin', orgId: 'org-a' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

async function signedIn(userId: string, signInMethod: string): Promise<void> {
  await db.user.create({ data: { id: userId, email: `${userId}@acme.test`, name: userId, emailVerified: true } });
  await db.session.create({
    data: { id: `s-${userId}`, token: `t-${userId}`, userId, expiresAt: new Date(Date.now() + HOUR), signInMethod },
  });
}

beforeEach(async () => {
  store = await createTestDb();
  db = store.db;
  await db.organization.create({ data: { id: 'org-a', name: 'Acme', slug: 'acme' } });
  await db.user.create({ data: { id: 'u-admin', email: 'admin@acme.test', name: 'Admin' } });
  await db.member.create({ data: { id: 'm-admin', organizationId: 'org-a', userId: 'u-admin', role: 'admin' } });
  await signedIn('pw', 'password');
  await signedIn('kim', 'sso:acme');
});

afterEach(async () => {
  await store.close();
});

const readyProvider = () =>
  db.ssoProvider.create({
    data: {
      orgId: 'org-a',
      providerId: 'acme',
      protocol: 'saml',
      domain: 'acme.test',
      issuer: 'https://idp.acme.test',
      metadata: { entryPoint: 'https://idp.acme.test/sso', cert: 'MIIC' },
    },
  });

describe('SSO invite links', () => {
  const link = { role: 'member' as const, expiry: '7d' as const, maxUses: 10, requireSso: true };

  it('refuses minting one while no SSO provider of the org can sign people in', async () => {
    await expect(createInviteLink(ctxFor('u-admin'), link)).rejects.toMatchObject({ cause: { swarmyCode: 'SSO_NOT_READY' } });
  });

  it('a password session can’t use it; the org’s SSO can, and the preview says so', async () => {
    await readyProvider();
    const issued = await createInviteLink(ctxFor('u-admin'), link);
    expect(issued.requireSso).toBe(true);
    const token = decodeURIComponent(issued.url.split('/join/')[1]!);
    expect((await inviteLinkPreview(db, token))?.requireSso).toBe(true);
    await expect(acceptInviteLink(ctxFor('pw'), token)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { swarmyCode: 'INVITE_SSO_REQUIRED', reason: 'sso_required' },
    });
    expect((await db.inviteLink.findFirst())?.uses).toBe(0);
    expect(await acceptInviteLink(ctxFor('kim'), token)).toEqual({ orgId: 'org-a', alreadyMember: false });
    expect(await db.member.findFirst({ where: { userId: 'kim' } })).toMatchObject({ organizationId: 'org-a', role: 'member' });
  });
});

describe('acceptInvitation (single-use) for an SSO invite', () => {
  it('tells a password session to sign in with SSO, and leaves the invite pending', async () => {
    await readyProvider();
    await db.invitation.create({
      data: {
        id: 'inv-pw',
        organizationId: 'org-a',
        email: 'pw@acme.test',
        role: 'member',
        requireSso: true,
        expiresAt: new Date(Date.now() + HOUR),
        inviterId: 'u-admin',
      },
    });
    await expect(acceptInvitation(ctxFor('pw'), 'inv-pw')).rejects.toMatchObject({
      cause: { swarmyCode: 'INVITE_SSO_REQUIRED', reason: 'sso_required' },
    });
    expect((await db.invitation.findUnique({ where: { id: 'inv-pw' } }))?.status).toBe('pending');
  });
});
