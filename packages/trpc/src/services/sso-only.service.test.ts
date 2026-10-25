import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { enforceOrgSso } from './sso-only-gate';
import { assertSsoOnlyKeepsProvider, getSsoOnly, setSsoOnly } from './sso-only.service';

// The org switch against the real migrations: it needs a ready provider,
// won't sign out the admin turning it on, and signs out everyone it now refuses.

const HOUR = 3_600_000;
let store: TestDb;
let db: DB;

async function person(id: string, role: string, session: { method: string | null; mfa?: boolean }): Promise<void> {
  await db.user.create({ data: { id, email: `${id}@acme.test`, name: id, emailVerified: true } });
  await db.member.create({ data: { id: `m-${id}`, organizationId: 'org-a', userId: id, role } });
  await db.session.create({
    data: {
      id: `s-${id}`,
      token: `t-${id}`,
      userId: id,
      expiresAt: new Date(Date.now() + HOUR),
      activeOrganizationId: 'org-a',
      signInMethod: session.method,
      mfaVerifiedAt: session.mfa ? new Date() : null,
    },
  });
}

function ctxFor(id: string, role: 'owner' | 'admin' | 'member'): OrgContext {
  return {
    db,
    activeOrgId: 'org-a',
    session: { id: `s-${id}` },
    user: { id },
    membership: { role, orgId: 'org-a' },
  } as unknown as OrgContext;
}

const samlRow = (providerId: string, orgId = 'org-a', ready = true) => ({
  orgId,
  providerId,
  protocol: 'saml',
  issuer: 'https://idp.acme.test',
  metadata: ready ? { entryPoint: 'https://idp.acme.test/sso', cert: 'MIIC' } : {},
});

beforeEach(async () => {
  store = await createTestDb();
  db = store.db;
  await db.organization.create({ data: { id: 'org-a', name: 'Acme', slug: 'acme' } });
  await db.organization.create({ data: { id: 'org-b', name: 'Other', slug: 'other' } });
  await person('admin-sso', 'admin', { method: 'sso:acme' });
  await person('admin-pw', 'admin', { method: 'password' });
  await person('owner-2fa', 'owner', { method: 'password_2fa', mfa: true });
  await person('dev-social', 'member', { method: 'social:github' });
  await person('dev-legacy', 'member', { method: null });
  await person('dev-elsewhere', 'member', { method: 'sso:other' });
});

afterEach(async () => {
  await store.close();
});

describe('setSsoOnly', () => {
  it('refuses to turn on without a ready SSO provider of this org', async () => {
    await db.ssoProvider.create({ data: samlRow('half', 'org-a', false) });
    await db.ssoProvider.create({ data: samlRow('other', 'org-b') });
    await expect(setSsoOnly(ctxFor('admin-sso', 'admin'), true)).rejects.toMatchObject({ cause: { swarmyCode: 'SSO_NOT_READY' } });
    expect(await db.orgSecurityPolicy.findUnique({ where: { orgId: 'org-a' } })).toBeNull();
  });

  it('refuses to sign out the admin turning it on', async () => {
    await db.ssoProvider.create({ data: samlRow('acme') });
    expect((await getSsoOnly(ctxFor('admin-pw', 'admin'))).keepsYouSignedIn).toBe(false);
    await expect(setSsoOnly(ctxFor('admin-pw', 'admin'), true)).rejects.toMatchObject({ cause: { swarmyCode: 'SSO_ONLY_LOCKOUT' } });
  });

  it('turns on, signs out every session it now refuses, and audits it', async () => {
    await db.ssoProvider.create({ data: samlRow('acme') });
    await db.ssoProvider.create({ data: samlRow('other', 'org-b') });
    const res = await setSsoOnly(ctxFor('admin-sso', 'admin'), true);
    expect(res).toMatchObject({ on: true, signedOut: 4, ready: [{ providerId: 'acme', protocol: 'saml' }] });
    const left = (await db.session.findMany({ select: { userId: true } })).map((s) => s.userId).sort();
    expect(left).toEqual(['admin-sso', 'owner-2fa']);
    expect((await db.user.findUnique({ where: { id: 'dev-social' } }))?.tokensRevokedAt).toBeInstanceOf(Date);
    const audit = await db.auditLog.findFirst({ where: { action: 'security.ssoOnly.set' } });
    expect(audit?.metadata).toMatchObject({ requireSso: true, providers: ['acme'], signedOut: 4 });
  });

  it('an owner on password + 2FA may turn it on (break-glass keeps them in)', async () => {
    await db.ssoProvider.create({ data: samlRow('acme') });
    expect((await setSsoOnly(ctxFor('owner-2fa', 'owner'), true)).on).toBe(true);
  });
});

describe('enforceOrgSso (the orgProcedure gate)', () => {
  beforeEach(async () => {
    await db.ssoProvider.create({ data: samlRow('acme') });
    await db.orgSecurityPolicy.create({ data: { orgId: 'org-a', requireSso: true } });
  });
  const gate = (id: string, role: 'owner' | 'admin' | 'member') =>
    enforceOrgSso(db, { session: { id: `s-${id}` }, orgId: 'org-a', role, memberSince: new Date() });

  it('lets the org’s own SSO and an owner’s password + 2FA through', async () => {
    await gate('admin-sso', 'admin');
    await gate('owner-2fa', 'owner');
  });

  it('refuses password, social, another org’s SSO and sessions from before the switch', async () => {
    for (const [id, role] of [['admin-pw', 'admin'], ['dev-social', 'member'], ['dev-elsewhere', 'member'], ['dev-legacy', 'member']] as const) {
      await expect(gate(id, role)).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { swarmyCode: 'SSO_REQUIRED' } });
    }
  });

  it('does nothing while the switch is off', async () => {
    await db.orgSecurityPolicy.update({ where: { orgId: 'org-a' }, data: { requireSso: false } });
    await gate('dev-social', 'member');
  });
});

describe('assertSsoOnlyKeepsProvider', () => {
  it('refuses removing the last ready provider while the switch is on', async () => {
    await db.ssoProvider.create({ data: samlRow('acme') });
    await db.orgSecurityPolicy.create({ data: { orgId: 'org-a', requireSso: true } });
    const ctx = ctxFor('admin-sso', 'admin');
    await expect(assertSsoOnlyKeepsProvider(ctx, 'acme')).rejects.toMatchObject({ cause: { swarmyCode: 'SSO_ONLY_LAST_PROVIDER' } });
    await db.ssoProvider.create({ data: samlRow('backup') });
    await assertSsoOnlyKeepsProvider(ctx, 'acme');
  });
});
