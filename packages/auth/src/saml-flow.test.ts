import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import { loadAuthConfig } from './config';
import { idpPlaceholderEmail } from './identity-idp';
import { samlSpUrls } from './saml';
import { selfSignedCert, testIdp, type TestAssertion } from './saml-testing';
import { buildAuth } from './server';

// End to end through the real plugin and the real migrations: a signed
// assertion from a throwaway IdP (key generated here) signs a person in, and
// everything the plugin should refuse is refused before any session exists.

const BASE = 'http://localhost:3021';
const IDP = testIdp('https://idp.acme.test/saml', 'https://idp.acme.test/sso');
const SP = samlSpUrls('acme', BASE);
const ENV = ['BETTER_AUTH_URL', 'CONTROLLER_PUBLIC_URL', 'SWARMY_ALLOW_SIGNUP', 'SWARMY_AUTH_RATE_LIMIT'] as const;

describe('SAML sign-in end to end', () => {
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
    // Not the first user: sign-up is invite-only, so only the IdP admits people.
    await db.user.create({ data: { id: 'u-owner', email: 'owner@acme.test', name: 'Owner', emailVerified: true } });
    await db.ssoProvider.create({
      data: {
        orgId: 'org-1',
        protocol: 'saml',
        providerId: 'acme',
        issuer: IDP.entityId,
        metadata: { entryPoint: IDP.ssoUrl, cert: IDP.cert, groupMap: { 'idp-sre': 'ops' } },
        mapping: { email: 'mail', groups: 'memberOf' },
      },
    });
    const config = await loadAuthConfig(db);
    auth = buildAuth(config, { db, audit: async (_org, e) => void audits.push(e.action) });
  }, 60_000);

  afterAll(async () => {
    await store.close();
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  const call = (path: string, init: RequestInit = {}) => auth.handler(new Request(`${BASE}/api/auth${path}`, init));

  /** SP-initiated: POST /sign-in/sso, read the AuthnRequest ID + RelayState off the redirect. */
  async function start(): Promise<{ id: string; relay: string }> {
    const res = await call('/sign-in/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ providerId: 'acme', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(IDP.ssoUrl);
    const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    return { id: /\bID="([^"]+)"/.exec(xml)![1]!, relay: url.searchParams.get('RelayState') ?? '' };
  }

  async function acs(samlResponse: string, relay: string) {
    const res = await call(`/sso/saml2/sp/acs/acme`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.acme.test' },
      body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relay }).toString(),
    });
    const signedIn = res.headers.getSetCookie().some((c) => c.startsWith('swarmy.session_token=') && !/max-age=0/i.test(c));
    return { status: res.status, location: res.headers.get('location') ?? '', signedIn };
  }

  const alice = (inResponseTo: string, over: Partial<TestAssertion> = {}): TestAssertion => ({
    inResponseTo,
    nameId: 'Alice-7Hx',
    attributes: { mail: 'alice@acme.test', memberOf: ['idp-sre', 'idp-other'] },
    ...over,
  });

  it('signs a person in and provisions them into the provider org with mapped groups', async () => {
    const { id, relay } = await start();
    const res = await acs(await IDP.signedResponse(SP, alice(id)), relay);
    expect(res).toMatchObject({ status: 302, signedIn: true });
    expect(res.location).not.toContain('error=');
    const user = await db.user.findUnique({ where: { email: 'alice@acme.test' }, include: { accounts: true } });
    expect(user?.accounts.map((a) => [a.providerId, a.accountId])).toEqual([['acme', 'Alice-7Hx']]);
    const member = await db.member.findFirst({ where: { userId: user!.id } });
    expect(member).toMatchObject({ organizationId: 'org-1', role: 'member', attributes: { ssoGroups: ['ops'] } });
    expect(audits).toContain('member.sso.provision');
    const session = await db.session.findFirst({ where: { userId: user!.id } });
    expect(session?.activeOrganizationId).toBe('org-1');
  });

  it('refuses a replayed response (the AuthnRequest and the assertion id are single-use)', async () => {
    const { id, relay } = await start();
    const signed = await IDP.signedResponse(SP, alice(id, { assertionId: '_once' }));
    expect((await acs(signed, relay)).signedIn).toBe(true);
    const again = await acs(signed, relay);
    expect(again.signedIn).toBe(false);
    expect(again.location).toContain('error=saml_unsolicited');
    // A fresh request answered with an assertion id already spent: the plugin's replay guard.
    const next = await start();
    const reused = await acs(await IDP.signedResponse(SP, alice(next.id, { assertionId: '_once' })), next.relay);
    expect(reused.signedIn).toBe(false);
    expect(reused.location).toContain('error=replay_detected');
  });

  it('refuses an unsigned response, a tampered one, and one signed by another key', async () => {
    const unsigned = await start();
    expect((await acs(IDP.unsignedResponse(SP, alice(unsigned.id)), unsigned.relay)).signedIn).toBe(false);

    const tampered = await start();
    const xml = Buffer.from(await IDP.signedResponse(SP, alice(tampered.id)), 'base64').toString();
    const forged = Buffer.from(xml.replace('alice@acme.test', 'owner@acme.test')).toString('base64');
    expect((await acs(forged, tampered.relay)).signedIn).toBe(false);

    const rogue = testIdp(IDP.entityId, IDP.ssoUrl, selfSignedCert('rogue'));
    const other = await start();
    expect((await acs(await rogue.signedResponse(SP, alice(other.id)), other.relay)).signedIn).toBe(false);
    expect(await db.account.count({ where: { userId: 'u-owner' } })).toBe(0);
  });

  it('refuses an unsolicited response and one meant for another SP', async () => {
    const { relay } = await start();
    expect((await acs(await IDP.signedResponse(SP, alice('_never-asked')), relay)).signedIn).toBe(false);
    const other = await start();
    const elsewhere = alice(other.id, { audience: 'https://other-sp.test/metadata' });
    expect((await acs(await IDP.signedResponse(SP, elsewhere), other.relay)).signedIn).toBe(false);
  });

  it('gives an IdP that sends no email the hashed IdP placeholder', async () => {
    const { id, relay } = await start();
    const res = await acs(await IDP.signedResponse(SP, alice(id, { nameId: 'Opaque-Q9', attributes: {} })), relay);
    expect(res.signedIn).toBe(true);
    const user = await db.user.findFirst({ where: { accounts: { some: { providerId: 'acme', accountId: 'Opaque-Q9' } } } });
    expect(user?.email).toBe(idpPlaceholderEmail('acme', 'opaque-q9'));
  });
});
