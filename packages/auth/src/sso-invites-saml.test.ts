import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import { loadAuthConfig } from './config';
import { samlSpUrls } from './saml';
import { testIdp } from './saml-testing';
import { buildAuth } from './server';

// The SAML gap, closed: the IdP's POST to the ACS is cross-site, so no invite
// cookie arrives. The sign-in hook redeems the SSO invite naming the address
// the IdP vouched for, in an org that signs in with SSO only, with the role
// the invite gave (not the provider's auto-provision default).

const BASE = 'http://localhost:3021';
const ENV = ['BETTER_AUTH_URL', 'CONTROLLER_PUBLIC_URL', 'SWARMY_ALLOW_SIGNUP', 'SWARMY_AUTH_RATE_LIMIT'] as const;
const IDP = testIdp('https://idp.acme.test/saml', 'https://idp.acme.test/sso');
const SP = samlSpUrls('acme', BASE);

describe('SSO invites over SAML (no invite cookie)', () => {
  let store: TestDb;
  let db: DB;
  let auth: ReturnType<typeof buildAuth>;
  const audits: string[] = [];
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
    await db.orgSecurityPolicy.create({ data: { orgId: 'org-1', requireSso: true } });
    // Auto-provision off: only an invite admits people.
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
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.invitation.create({
      data: { id: 'inv-alice', organizationId: 'org-1', email: 'alice@acme.test', role: 'admin', requireSso: true, expiresAt, inviterId: 'u-owner' },
    });
    auth = buildAuth(await loadAuthConfig(db), { db, audit: async (_org, e) => void audits.push(e.action) });
  }, 60_000);

  afterAll(async () => {
    await store.close();
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  const call = (path: string, init: RequestInit) => auth.handler(new Request(`${BASE}/api/auth${path}`, init));

  async function samlSignIn(mail: string, nameId: string): Promise<boolean> {
    const start = await call('/sign-in/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ providerId: 'acme', callbackURL: '/' }),
    });
    const url = new URL(((await start.json()) as { url: string }).url);
    const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    const id = /\bID="([^"]+)"/.exec(xml)![1]!;
    const res = await call('/sso/saml2/sp/acs/acme', {
      method: 'POST',
      // The IdP's cross-site POST: no swarmy_invite cookie.
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.acme.test' },
      body: new URLSearchParams({
        SAMLResponse: await IDP.signedResponse(SP, { inResponseTo: id, nameId, attributes: { mail } }),
        RelayState: url.searchParams.get('RelayState') ?? '',
      }).toString(),
    });
    return res.headers.getSetCookie().some((c) => c.startsWith('swarmy.session_token=') && !/max-age=0/i.test(c));
  }

  it('redeems the SSO invite by the IdP-vouched address, with the invited role, into the SSO-only org', async () => {
    expect(await samlSignIn('alice@acme.test', 'alice-1')).toBe(true);
    const user = await db.user.findUnique({ where: { email: 'alice@acme.test' } });
    expect(await db.member.findFirst({ where: { userId: user!.id } })).toMatchObject({ organizationId: 'org-1', role: 'admin' });
    expect((await db.invitation.findUnique({ where: { id: 'inv-alice' } }))?.status).toBe('accepted');
    const session = await db.session.findFirst({ where: { userId: user!.id } });
    expect(session).toMatchObject({ activeOrganizationId: 'org-1', signInMethod: 'sso:acme' });
    expect(audits).toContain('member.invite.accept');
  });

  it('admits nobody the directory has but no invite names (auto-provision is off)', async () => {
    expect(await samlSignIn('mallory@acme.test', 'mallory-1')).toBe(false);
    expect(await db.user.findUnique({ where: { email: 'mallory@acme.test' } })).toBeNull();
  });
});
