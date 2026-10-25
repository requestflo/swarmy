import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import { invitePlaceholderEmail } from './identity';
import { redeemInvitation } from './invite-redeem';
import { isSignupAllowed } from './signup-policy';
import { ssoInviteDecision } from './sso-invites';

const LINK = invitePlaceholderEmail('tok');
const own = { orgId: 'org-a', domain: 'acme.test' };
const sso = { kind: 'sso' as const, providerId: 'acme' };

describe('ssoInviteDecision: who may redeem an invite that must be accepted with SSO', () => {
  const table: Array<[string, Parameters<typeof ssoInviteDecision>[0], string]> = [
    ['own SSO, the invited address', { invitedEmail: 'sam@acme.test', inviteOrgId: 'org-a', signIn: sso, provider: own, email: 'Sam@Acme.test' }, 'ok'],
    ['own SSO, another address', { invitedEmail: 'sam@acme.test', inviteOrgId: 'org-a', signIn: sso, provider: own, email: 'eve@acme.test' }, 'sso_email_mismatch'],
    ['own SSO, no address from the IdP', { invitedEmail: 'sam@acme.test', inviteOrgId: 'org-a', signIn: sso, provider: own, email: 'x@acme.idp.swarmy.invalid' }, 'sso_email_mismatch'],
    ['password', { invitedEmail: 'sam@acme.test', inviteOrgId: 'org-a', signIn: { kind: 'password', providerId: null }, provider: null, email: 'sam@acme.test' }, 'sso_required'],
    ['another org’s SSO', { invitedEmail: 'sam@acme.test', inviteOrgId: 'org-a', signIn: sso, provider: { orgId: 'org-b', domain: null }, email: 'sam@acme.test' }, 'sso_required'],
    ['link, own SSO at the provider’s domain', { invitedEmail: LINK, inviteOrgId: 'org-a', signIn: sso, provider: own, email: 'kim@acme.test' }, 'ok'],
    ['link, own SSO at another domain', { invitedEmail: LINK, inviteOrgId: 'org-a', signIn: sso, provider: own, email: 'kim@gmail.test' }, 'sso_domain_mismatch'],
    ['link, own SSO with no domain set', { invitedEmail: null, inviteOrgId: 'org-a', signIn: sso, provider: { orgId: 'org-a', domain: null }, email: null }, 'ok'],
    ['link, social', { invitedEmail: null, inviteOrgId: 'org-a', signIn: { kind: 'social', providerId: 'github' }, provider: null, email: 'kim@acme.test' }, 'sso_required'],
  ];
  for (const [name, input, want] of table) {
    it(name, () => {
      const d = ssoInviteDecision(input);
      expect(d.ok ? 'ok' : d.reason).toBe(want);
    });
  }
});

describe('redeemInvitation for SSO invites (real migrations)', () => {
  let store: TestDb;
  let db: DB;
  const DAY = 86_400_000;

  async function invite(id: string, email: string, requireSso: boolean, role = 'member'): Promise<void> {
    await db.invitation.create({
      data: { id, organizationId: 'org-a', email, role, requireSso, expiresAt: new Date(Date.now() + DAY), inviterId: 'u-owner' },
    });
  }
  const redeem = (invitationId: string, signInMethod: string | null, email = 'sam@acme.test') =>
    redeemInvitation(db, { invitationId, user: { id: 'u-sam', email, emailVerified: true }, signInMethod });

  beforeEach(async () => {
    store = await createTestDb();
    db = store.db;
    await db.organization.create({ data: { id: 'org-a', name: 'Acme', slug: 'acme' } });
    await db.organization.create({ data: { id: 'org-b', name: 'Other', slug: 'other' } });
    await db.user.create({ data: { id: 'u-owner', email: 'owner@acme.test', name: 'Owner' } });
    await db.user.create({ data: { id: 'u-sam', email: 'sam@acme.test', name: 'Sam', emailVerified: true } });
    await db.ssoProvider.create({ data: { orgId: 'org-a', providerId: 'acme', protocol: 'saml', domain: 'acme.test' } });
    await db.ssoProvider.create({ data: { orgId: 'org-b', providerId: 'other', protocol: 'oidc' } });
  });
  afterEach(async () => {
    await store.close();
  });

  it('refuses a verified address that signed in with a password, and leaves the invite pending', async () => {
    await invite('inv-1', 'sam@acme.test', true, 'admin');
    expect(await redeem('inv-1', 'password')).toMatchObject({ ok: false, reason: 'sso_required', sso: 'sso_required' });
    expect(await redeem('inv-1', 'sso:other')).toMatchObject({ ok: false, sso: 'sso_required' });
    expect((await db.invitation.findUnique({ where: { id: 'inv-1' } }))?.status).toBe('pending');
    expect(await db.member.count()).toBe(0);
  });

  it('accepts the invited address through the org’s own SSO, with the invited role', async () => {
    await invite('inv-1', 'sam@acme.test', true, 'admin');
    expect(await redeem('inv-1', 'sso:acme', 'eve@acme.test')).toMatchObject({ ok: false, sso: 'sso_email_mismatch' });
    expect(await redeem('inv-1', 'sso:acme')).toMatchObject({ ok: true, orgId: 'org-a', role: 'admin', created: true });
  });

  it('a link invite takes anyone from the org’s SSO at the provider’s domain', async () => {
    await invite('inv-l', LINK, true);
    expect(await redeem('inv-l', 'sso:acme', 'sam@gmail.test')).toMatchObject({ ok: false, sso: 'sso_domain_mismatch' });
    expect(await redeem('inv-l', 'sso:acme')).toMatchObject({ ok: true, orgId: 'org-a' });
  });

  it('in an org that signs in with SSO only, every invite must be accepted with SSO', async () => {
    await db.orgSecurityPolicy.create({ data: { orgId: 'org-a', requireSso: true } });
    await invite('inv-p', 'sam@acme.test', false);
    expect(await redeem('inv-p', 'password')).toMatchObject({ ok: false, reason: 'sso_required' });
    expect(await redeem('inv-p', 'sso:acme')).toMatchObject({ ok: true });
  });

  it('a plain invite in a normal org still redeems with a password', async () => {
    await invite('inv-p', 'sam@acme.test', false);
    expect(await redeem('inv-p', 'password')).toMatchObject({ ok: true });
  });

  it('sign-up admission: an SSO invite admits a new account only through the org’s SSO', async () => {
    await invite('inv-1', 'new@acme.test', true);
    const env = { SWARMY_ALLOW_SIGNUP: 'false' };
    const now = new Date();
    expect(await isSignupAllowed(db, 'new@acme.test', env, now, { inviteId: 'inv-1', emailVerified: true })).toBe(false);
    expect(await isSignupAllowed(db, 'new@acme.test', env, now, { emailVerified: true, idpOrgId: 'org-b' })).toBe(false);
    expect(await isSignupAllowed(db, 'new@acme.test', env, now, { idpOrgId: 'org-a' })).toBe(true);
  });
});
