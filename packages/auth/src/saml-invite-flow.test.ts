import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { hashToken } from '@swarmy/core/crypto';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import { loadAuthConfig } from './config';
import { invitePlaceholderEmail } from './identity';
import { samlSpUrls } from './saml';
import { samlBrowser, testIdp } from './saml-testing';
import { buildAuth } from './server';

// The link-invite SAML gap, closed: a new person on an invite link (no address
// to match), auto-provisioning off. The IdP's POST to the ACS carries no invite
// cookie, so the invite rides the AuthnRequest record (saml-invite.ts). Driven
// through the real plugin, the real migrations and a throwaway IdP key.

const BASE = 'http://localhost:3021';
const ENV = ['BETTER_AUTH_URL', 'CONTROLLER_PUBLIC_URL', 'SWARMY_ALLOW_SIGNUP', 'SWARMY_AUTH_RATE_LIMIT'] as const;
const IDP = testIdp('https://idp.acme.test/saml', 'https://idp.acme.test/sso');
const SP = samlSpUrls('acme', BASE);
const DAY = 86_400_000;

describe('link invites over SAML (auto-provisioning off)', () => {
  let store: TestDb;
  let db: DB;
  let saml: ReturnType<typeof samlBrowser>;
  const audits: string[] = [];
  const grants: string[] = [];
  const saved = ENV.map((k) => process.env[k]);

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-000';
    Object.assign(process.env, { BETTER_AUTH_URL: BASE, SWARMY_ALLOW_SIGNUP: 'false', SWARMY_AUTH_RATE_LIMIT: '0' });
    delete process.env.CONTROLLER_PUBLIC_URL;
    store = await createTestDb();
    db = store.db;
    await db.organization.create({ data: { id: 'org-1', name: 'Acme', slug: 'acme' } });
    await db.user.create({ data: { id: 'u-owner', email: 'owner@acme.test', name: 'Owner', emailVerified: true } });
    await db.member.create({ data: { id: 'm-owner', organizationId: 'org-1', userId: 'u-owner', role: 'owner' } });
    await db.ssoProvider.create({
      data: {
        orgId: 'org-1',
        protocol: 'saml',
        providerId: 'acme',
        domain: 'acme.test',
        issuer: IDP.entityId,
        metadata: { entryPoint: IDP.ssoUrl, cert: IDP.cert, autoProvision: false },
        mapping: { email: 'mail' },
      },
    });
    const auth = buildAuth(await loadAuthConfig(db), {
      db,
      audit: async (_org, e) => void audits.push(e.action),
      grantInviteApp: async (_org, g) => void grants.push(g.stackName),
    });
    saml = samlBrowser((req) => auth.handler(req), BASE, 'acme');
  }, 60_000);

  afterAll(async () => {
    await store.close();
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  let n = 0;
  /** An SSO invite link of org-1 (requireSso), as the admin UI mints one. */
  async function link(over: { expiresAt?: Date; stackName?: string } = {}) {
    const token = `swi_t${++n}_secret-${n}`;
    const [expiresAt, stackName] = [over.expiresAt ?? new Date(Date.now() + DAY), over.stackName ?? null];
    const row = await db.inviteLink.create({
      data: { orgId: 'org-1', tokenHash: hashToken(token), prefix: `t${n}`, role: 'member', stackName, expiresAt, maxUses: 5, requireSso: true },
    });
    return { token, id: row.id, cookie: `swarmy_invite=${token}` };
  }
  const answer = (inResponseTo: string, who: string) =>
    IDP.signedResponse(SP, { inResponseTo, nameId: who, attributes: { mail: `${who}@acme.test` } });
  const userOf = (who: string) => db.user.findUnique({ where: { email: `${who}@acme.test` } });
  const memberOf = (who: string) => db.member.findFirst({ where: { organizationId: 'org-1', user: { email: `${who}@acme.test` } } });
  const uses = async (id: string) => (await db.inviteLink.findUniqueOrThrow({ where: { id } })).uses;
  const bound = async (requestId: string) =>
    JSON.parse((await db.verification.findFirst({ where: { identifier: `saml-authn-request:${requestId}` } }))!.value) as Record<string, unknown>;

  it('signs a new person up on an SSO invite link, binding only the link’s row id to the AuthnRequest', async () => {
    const l = await link({ stackName: 'shop' });
    const { id, relay } = await saml.start(l.cookie);
    const record = await bound(id);
    expect(record).toMatchObject({ providerId: 'acme', swarmyInvite: { kind: 'link', id: l.id } });
    expect(JSON.stringify(record)).not.toContain(l.token);
    expect((await saml.acs(await answer(id, 'alice'), relay)).signedIn).toBe(true);
    expect(await memberOf('alice')).toMatchObject({ role: 'member' });
    expect(await uses(l.id)).toBe(1);
    expect(grants).toEqual(['shop']);
    expect(audits).toContain('member.inviteLink.accept');
    const session = await db.session.findFirst({ where: { user: { email: 'alice@acme.test' } } });
    expect(session).toMatchObject({ activeOrganizationId: 'org-1', signInMethod: 'sso:acme' });
  });

  it('signs a new person up on a link-only single-use invitation, with its role', async () => {
    const expiresAt = new Date(Date.now() + DAY);
    const email = invitePlaceholderEmail('inv-link');
    await db.invitation.create({ data: { id: 'inv-link', organizationId: 'org-1', email, role: 'admin', requireSso: true, expiresAt, inviterId: 'u-owner' } });
    const { id, relay } = await saml.start('swarmy_invite=inv-link');
    expect((await saml.acs(await answer(id, 'bea'), relay)).signedIn).toBe(true);
    expect(await memberOf('bea')).toMatchObject({ role: 'admin' });
    expect((await db.invitation.findUnique({ where: { id: 'inv-link' } }))?.status).toBe('accepted');
  });

  it('a stolen RelayState or a replayed reference redeems nothing for anyone else', async () => {
    const l = await link();
    const victim = await saml.start(l.cookie);
    const thief = await saml.start();
    // RelayState names no invite: the thief's own answer, sent with the victim's RelayState, is still uninvited.
    expect((await saml.acs(await answer(thief.id, 'mallory'), victim.relay)).signedIn).toBe(false);
    const signed = await answer(victim.id, 'carol');
    expect((await saml.acs(signed, victim.relay)).signedIn).toBe(true);
    // The reference is consumed once: a replay, or an IdP answer for the thief to that same request, is unsolicited.
    expect((await saml.acs(signed, victim.relay)).location).toContain('error=saml_unsolicited');
    const reused = await saml.acs(await answer(victim.id, 'mallory'), victim.relay);
    expect(reused).toMatchObject({ signedIn: false, location: expect.stringContaining('error=saml_unsolicited') });
    expect(await userOf('mallory')).toBeNull();
    expect(await uses(l.id)).toBe(1);
  });

  it('refuses an expired invite, whether it expired before the sign-in started or before the IdP answered', async () => {
    const stale = await link({ expiresAt: new Date(Date.now() - 1000) });
    const a = await saml.start(stale.cookie);
    expect((await bound(a.id)).swarmyInvite).toBeUndefined();
    expect((await saml.acs(await answer(a.id, 'dan'), a.relay)).signedIn).toBe(false);
    const l = await link();
    const b = await saml.start(l.cookie);
    await db.inviteLink.update({ where: { id: l.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await saml.acs(await answer(b.id, 'dan'), b.relay)).signedIn).toBe(false);
    expect(await userOf('dan')).toBeNull();
    expect(await uses(l.id)).toBe(0);
  });

  it('a sign-in not started from an invite redeems nothing', async () => {
    const l = await link();
    const a = await saml.start();
    expect((await saml.acs(await answer(a.id, 'erin'), a.relay)).signedIn).toBe(false);
    expect(await userOf('erin')).toBeNull();
    // An account outside the org (alice, removed after joining) signs in, and stays outside.
    await db.member.deleteMany({ where: { user: { email: 'alice@acme.test' } } });
    const b = await saml.start();
    expect((await saml.acs(await answer(b.id, 'alice'), b.relay)).signedIn).toBe(true);
    expect(await memberOf('alice')).toBeNull();
    expect(await uses(l.id)).toBe(0);
  });
});
